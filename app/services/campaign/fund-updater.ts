import DB from "../../db/db";
import {
  SetupInterface,
} from "../../interfaces";
import { Connection, PublicKey } from "@solana/web3.js";
import { Model, Connection as DbConnection, Types } from 'mongoose';

import CampaignSchema, { ICampaign } from "../../db/schema/campaign.schema";
import TransactionSchema, { ITransaction } from "../../db/schema/transaction.schema";
import AddTokenPumpProcessSchema, {AddTokenProcessStatus, IAddTokenPumpProcess} from "../../db/schema/token-process.schema";
import { BN } from '@coral-xyz/anchor';

require("dotenv").config();
const { Keypair } = require('@solana/web3.js');

export default class CampaignFundService {
  private db: DB;
  private static instance: CampaignFundService;
  private isSyncing: boolean = false;
  private devnet = false;
  private rpc: string;
  private PROGRAM_ID: string = 'GwAWdhc8NuRVCRn4guyXz7UGaQHCwnnVppBKMtZmxVM2'

  private connection;
  private dbConnection: DbConnection;
  // list models
  private campaignModel: Model<ICampaign>;
  private transactionModel: Model<ITransaction>;
  private addTokenPumpProcessModel: Model<IAddTokenPumpProcess>;

  public async setup(setup: SetupInterface) {
    this.db = setup._db;
    this.rpc = setup.rpc;
    this.devnet = setup.devnet;

    // Setup connection
    this.connection = new Connection(setup.rpc);
    // Setup db
    this.dbConnection = await this.db.getConnection();
    this.campaignModel = CampaignSchema.getModel();
    this.transactionModel = TransactionSchema.getModel();
    this.addTokenPumpProcessModel = AddTokenPumpProcessSchema.getModel();
  }


  public static getInstance(): CampaignFundService {
    if (!CampaignFundService.instance) {
      CampaignFundService.instance = new CampaignFundService();
    }

    return CampaignFundService.instance;
  }

  // Ensure that the cronjob is not running multiple times
  async fetch() {
    if (this.isSyncing) return;
    this.isSyncing = true;
  
    const MAX_RETRIES = 3;
    let retryCount = 0;
  
    while (retryCount < MAX_RETRIES) {
      try {
        console.log("Updating campaign funds");
        const session = await this.dbConnection.startSession();
  
        try {
          // Add transaction options with writeConcern
          session.startTransaction({
            readConcern: { level: 'snapshot' },
            writeConcern: { w: 'majority' }
          });

          // Update total funds
          await this.updateAllCampaignFunds(session);
          
          // Clean up zero fund campaigns 
          await this.cleanupZeroFundCampaigns(session);
          
          await session.commitTransaction();
          this.isSyncing = false;
          return; // Success - exit the retry loop
          
        } catch (e) {
          await session.abortTransaction();
          throw e;
        } finally {
          await session.endSession();
        }
  
      } catch (e) {
        if (e.code === 112) { // WriteConflict error code
          retryCount++;
          console.log(`Retry attempt ${retryCount} due to write conflict`);
          // Add exponential backoff
          const backoffMs = Math.pow(2, retryCount) * 1000;
          await new Promise(resolve => setTimeout(resolve, backoffMs));
        } else {
          console.log('CampaignFundService fetch error:', e);
          break; // Exit on non-WriteConflict errors
        }
      }
    }
  
    this.isSyncing = false;
    if (retryCount === MAX_RETRIES) {
      console.log('Max retries reached for handling write conflicts');
    }
  }

  async fetchNewTransFromHelius(address: string, after: string | null, before: string | null = null) {
    const trans = await this.connection.getSignaturesForAddress(
      new PublicKey(address),
      {
        limit: 1000,
        until: after,
        before,
      },
      'finalized',
    );
    console.log('CampaignService trans length:', trans.length);
    return trans;
  }

  async cleanupZeroFundCampaigns(session) {
    const campaigns = await this.campaignModel.find();
    
    for (const campaign of campaigns) {

      // Check campaign status - skip COMPLETED campaigns
      const processRecord = await this.addTokenPumpProcessModel.findOne({
        creator: campaign.creator,
        campaignIndex: campaign.campaignIndex,
      })

      // Also check if campaign has mint
      const campaignWithMint = await this.campaignModel.findOne({
        creator: campaign.creator,
        campaignIndex: campaign.campaignIndex,
        mint: { $exists: true, $ne: null }
      });

      if (processRecord?.status === AddTokenProcessStatus.COMPLETED || campaignWithMint?.mint) {
        console.log(`Skipping COMPLETED campaign or campaign with mint ${campaign.campaignIndex}`);
        continue;
      }

      // Get current on-chain state - ensure consistent PDA derivation
      // Smart contract uses 0-based indexing for PDA (subtract 1 from database index)
      const pdaCampaignIndex = campaign.campaignIndex - 1;
      const campaignIndexBN = new BN(pdaCampaignIndex);
      const [campaignPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from("campaign"), 
         new PublicKey(campaign.creator).toBuffer(), 
         Buffer.from(campaignIndexBN.toArray("le", 8))],
        new PublicKey(this.PROGRAM_ID)
      );
  
      const campaignInfo = await this.connection.getAccountInfo(campaignPDA);
      if (!campaignInfo) {
        console.log(`Campaign PDA ${campaignPDA.toString()} not found on-chain for campaign ${campaign.campaignIndex}`);
        
        // Double-check if campaign was recently completed before deletion
        const latestProcessRecord = await this.addTokenPumpProcessModel.findOne({
          creator: campaign.creator,
          campaignIndex: campaign.campaignIndex,
        });

        const latestCampaign = await this.campaignModel.findOne({
          creator: campaign.creator,
          campaignIndex: campaign.campaignIndex,
        });

        // Only delete if truly not completed and no mint
        if (latestProcessRecord?.status !== AddTokenProcessStatus.COMPLETED && 
            !latestCampaign?.mint &&
            latestCampaign) {
          console.log(`Deleting campaign ${campaign.campaignIndex} - PDA not found and not completed`);
          await this.campaignModel.deleteOne({ _id: campaign._id }, { session });
        } else {
          console.log(`Preserving campaign ${campaign.campaignIndex} - recently completed or has mint`);
        }
        continue;
      }
  
      const minimumRentExemption = await this.connection.getMinimumBalanceForRentExemption(campaignInfo.data.length);
      const currentFunds = campaignInfo.lamports - minimumRentExemption;
  
      // Double-check before deleting campaigns with zero funds
      const latestProcessRecord = await this.addTokenPumpProcessModel.findOne({
        creator: campaign.creator,
        campaignIndex: campaign.campaignIndex,
      });

      const latestCampaign = await this.campaignModel.findOne({
        creator: campaign.creator,
        campaignIndex: campaign.campaignIndex,
      });

      // Only delete if funds are 0 AND not completed AND no mint
      if (currentFunds === 0 && 
          latestProcessRecord?.status !== AddTokenProcessStatus.COMPLETED &&
          !latestCampaign?.mint &&
          latestCampaign) {
        console.log(`Deleting campaign ${campaign.campaignIndex} - zero funds and not completed`);
        await this.campaignModel.deleteOne({ 
          _id: campaign._id 
        }, { session });
      } else if (currentFunds === 0) {
        console.log(`Preserving campaign ${campaign.campaignIndex} with zero funds - completed or has mint`);
      }
    }
  }

  async updateCampaignFunds(campaign: ICampaign, session) {
    // Check if campaign is COMPLETED
    const processRecord = await this.addTokenPumpProcessModel.findOne({
      creator: campaign.creator,
      campaignIndex: campaign.campaignIndex,
    });

    if (processRecord?.status === AddTokenProcessStatus.COMPLETED) {
      console.log(`Campaign ${campaign.campaignIndex} is COMPLETED - skipping fund update`);
      return;
    }

    // Ensure consistent PDA derivation
    // Smart contract uses 0-based indexing for PDA (subtract 1 from database index)
    const pdaCampaignIndex = campaign.campaignIndex - 1;
    const campaignIndexBN = new BN(pdaCampaignIndex);
    const [campaignPDA] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("campaign"),
        new PublicKey(campaign.creator).toBuffer(),
        Buffer.from(campaignIndexBN.toArray("le", 8))
      ],
      new PublicKey(this.PROGRAM_ID)
    );
  
    const campaignInfo = await this.connection.getAccountInfo(campaignPDA);
    if (!campaignInfo) return;
  
    const minimumRentExemption = await this.connection.getMinimumBalanceForRentExemption(campaignInfo.data.length);
    const currentFunds = campaignInfo.lamports - minimumRentExemption;
  
    // Use compound key instead of _id
    await this.campaignModel.findOneAndUpdate(
      { 
        creator: campaign.creator,
        campaignIndex: campaign.campaignIndex 
      },
      { totalFundRaised: currentFunds },
      { session }
    );
  }
  
  // Function to update all campaign funds
  async updateAllCampaignFunds(session) {
    try {
      const campaigns = await this.campaignModel.find();
      
      for (const campaign of campaigns) {
        // Check COMPLETED status first - use fresh query to avoid race conditions
        const processRecord = await this.addTokenPumpProcessModel.findOne({
          creator: campaign.creator,
          campaignIndex: campaign.campaignIndex,
        });

        // Also check if campaign has mint (indicates token created)
        const campaignWithMint = await this.campaignModel.findOne({
          creator: campaign.creator,
          campaignIndex: campaign.campaignIndex,
          mint: { $exists: true, $ne: null }
        });

        if (processRecord?.status === AddTokenProcessStatus.COMPLETED || campaignWithMint?.mint) {
          console.log(`Campaign ${campaign.campaignIndex} is COMPLETED or has mint - skipping deletion`);
          continue;
        }

        // Ensure consistent PDA derivation
        // Smart contract uses 0-based indexing for PDA (subtract 1 from database index)
        const pdaCampaignIndex = campaign.campaignIndex - 1;
        const campaignIndexBN = new BN(pdaCampaignIndex);
        const [campaignPDA] = PublicKey.findProgramAddressSync(
          [
            Buffer.from("campaign"), 
            new PublicKey(campaign.creator).toBuffer(), 
            Buffer.from(campaignIndexBN.toArray("le", 8))
          ],
          new PublicKey(this.PROGRAM_ID)
        );
      const campaignInfo = await this.connection.getAccountInfo(campaignPDA);
      if (!campaignInfo) continue;

        const minimumRentExemption = await this.connection.getMinimumBalanceForRentExemption(campaignInfo.data.length);
        const currentFunds = campaignInfo.lamports - minimumRentExemption;

        // Double-check campaign status before deletion to avoid race conditions
        const latestProcessRecord = await this.addTokenPumpProcessModel.findOne({
          creator: campaign.creator,
          campaignIndex: campaign.campaignIndex,
        });

        const latestCampaign = await this.campaignModel.findOne({
          creator: campaign.creator,
          campaignIndex: campaign.campaignIndex,
        });

        // Only delete if:
        // 1. Current funds are 0
        // 2. NOT COMPLETED status
        // 3. No mint assigned (token not created)
        // 4. Campaign still exists in database
        if (currentFunds === 0 && 
            latestProcessRecord?.status !== AddTokenProcessStatus.COMPLETED && 
            !latestCampaign?.mint &&
            latestCampaign) {
          console.log(`Deleting campaign ${campaign.campaignIndex} - zero funds and not completed`);
          await this.campaignModel.deleteOne({ _id: campaign._id }, { session });
        } else {
          // Update funds only if campaign still exists and not being processed
          if (latestCampaign) {
            await this.campaignModel.findOneAndUpdate(
              { _id: campaign._id },
              { totalFundRaised: currentFunds },
              { session }
            );
          }
        }
      }
    } catch (error) {
      console.error('Error updating campaign funds:', error);
      throw error;
    }
  }
}