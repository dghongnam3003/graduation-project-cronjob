import DB from "../../db/db";
import {
  SetupInterface,
} from "../../interfaces";
import { Connection, PublicKey, SystemProgram, 
  SYSVAR_RENT_PUBKEY, 
  clusterApiUrl, 
  Transaction} from "@solana/web3.js";
import { Model, Connection as DbConnection, Types } from 'mongoose';

import CampaignSchema, { ICampaign } from "../../db/schema/campaign.schema";
import TransactionSchema, { ITransaction } from "../../db/schema/transaction.schema";
import AddTokenPumpProcessSchema, {AddTokenProcessStatus, IAddTokenPumpProcess} from "../../db/schema/token-process.schema";
import SellProgressSchema, { ISellProgress } from "../../db/schema/sell-progress.schema";
import { AnchorProvider, BorshCoder, Idl, Program, Wallet, EventParser, BN } from '@coral-xyz/anchor';
import IDL from '../idl/final_project.json';
import { PromisePool } from '@supercharge/promise-pool';
import { ethers } from 'ethers';
import { CampaignEvent } from "../../constant";
import { sleep } from "../../utils/sleep";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { findMetadataPda, MPL_TOKEN_METADATA_PROGRAM_ID } from "@metaplex-foundation/mpl-token-metadata";
import { 
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync
} from "@solana/spl-token";
import { 
  createUmi 
} from '@metaplex-foundation/umi-bundle-defaults';
import { 
  publicKey 
} from "@metaplex-foundation/umi";

require("dotenv").config();
const { Keypair } = require('@solana/web3.js');

export type GeckoResponse = {
  "data": {
    "id": "string",
    "type": "string",
    "attributes": {
      "name": "string",
      "address": "string",
      "symbol": "string",
      "decimals": 0,
      "total_supply": "string",
      "coingecko_coin_id": "string",
      "price_usd": "string",
      "fdv_usd": "string",
      "total_reserve_in_usd": "string",
      "volume_usd": {},
      "market_cap_usd": "string"
    },
    "relationships": {}
  }
}

export default class CampaignService {
  private db: DB;
  private static instance: CampaignService;
  private isSyncing: boolean = false;
  private devnet = false;
  private heliusKey: string;
  private rpc: string;
  private PROGRAM_ID: string = 'GwAWdhc8NuRVCRn4guyXz7UGaQHCwnnVppBKMtZmxVM2'

  private connection;
  private dbConnection: DbConnection;
  // list models
  private campaignModel: Model<ICampaign>;
  private transactionModel: Model<ITransaction>;
  private addTokenPumpProcessModel: Model<IAddTokenPumpProcess>;
  private sellProgressModel: Model<ISellProgress>;

  private operatorKeyPair = Keypair.fromSecretKey(bs58.decode(process.env.OPERATOR_PRIV_KEY || ""));

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
    this.sellProgressModel = SellProgressSchema.getModel();
  }


  public static getInstance(): CampaignService {
    if (!CampaignService.instance) {
      CampaignService.instance = new CampaignService();
    }

    return CampaignService.instance;
  }

  // Ensure that the cronjob is not running multiple times
  async fetch() {
    if (this.isSyncing) return;
    this.isSyncing = true;
  
    const MAX_RETRIES = 3;
    let retryCount = 0;
  
    while (retryCount < MAX_RETRIES) {
      try {
        console.log("Create Token check start");
        const session = await this.dbConnection.startSession();
  
        try {
          session.startTransaction();

          await this.syncAllCampaignStatuses(session);

          const sellProgresses = await this.sellProgressModel.find();

          for (const sellProgress of sellProgresses) {
            const campaign = await this.campaignModel.findOne({
              creator: sellProgress.creator,
              campaignIndex: sellProgress.campaignIndex,
            });

            if (campaign) {
              await this.monitorMarketCap(campaign, session);
            }
          }
          
          await this.syncNewTransaction();
          
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
        if (e.code === 112) {// WriteConflict error code
          retryCount++;
          console.log(`Retry attempt ${retryCount} due to write conflict`);
          // Add small delay before retry
          await new Promise(resolve => setTimeout(resolve, 1000));
        } else {
          console.log('CampaignService fetch error:', e);
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

  async syncNewTransaction() {
    let isDone = false;
    while (!isDone) {
      const signatureNeedHandle = [];
      const newestTran = await this.transactionModel.findOne({}).sort({ block: -1 }).exec();
      console.log('CampaignService newestTran revenue', newestTran?.id);
      // Fetch until reach the newest transaction if exist
      let catchedLastestTrans = false;
      let lastestTransSignature = null;
      while (!catchedLastestTrans) {
        const transactions = await this.fetchNewTransFromHelius(
          this.PROGRAM_ID,
          newestTran ? newestTran.signature : null,
          lastestTransSignature,
        );
        const signatures = transactions.filter((tran) => tran.err == null).map((tran: any) => tran.signature);
        if (signatures.length === 0) {
          catchedLastestTrans = true;
          break;
        }
        signatureNeedHandle.push(...signatures);
        // Push until reach the lastest transaction if exist
        if (!newestTran || signatureNeedHandle.includes(newestTran.signature) || transactions.length < 999) {
          catchedLastestTrans = true;
        } else {
          console.log('CampaignService Not found lastest trans yet, continue fetch');
          lastestTransSignature = signatures[signatures.length - 1];
        }
      }

      if (signatureNeedHandle.length === 0) {
        console.log('CampaignService No new transaction');
        isDone = false;
        break;
      }
      // Only remove the last signature if we have more than 1 signature
      // This prevents removing the only signature when there's just 1 new transaction
      if (signatureNeedHandle.length >= 48) {
        signatureNeedHandle.splice(-48);
      }
      const signatures = signatureNeedHandle.reverse();
      console.log('CampaignService signatures', signatures.length);
      await this.insertDataFromSignature(signatures);
    }
  }

  async insertDataFromSignature(signatures: string[]) {
    if (signatures.length === 0) {
      return;
    }
    // const splitedArr = this.chunkArray(signatures, 600);
    // console.log("splitedArr", splitedArr);
    const transNotInOrder = [];
    const chunkSize = 20;
    // Process signatures in chunks of 10
    for (let i = 0; i < signatures.length; i += chunkSize) {
      if (i > 0) {
        await sleep(10000)
      }
      const chunk = signatures.slice(i, i + chunkSize);
      const { results, errors } = await PromisePool.withConcurrency(1)
        .for(chunk)
        .process(async (arr) => {
          return await this.connection.getParsedTransaction(arr, {
            maxSupportedTransactionVersion: 0,
          });
        });

      if (errors.length > 0) {
        console.log("errors", errors);
        throw errors;
      }
      transNotInOrder.push(...results);
      console.log(`Processed signatures ${i + 1} to ${Math.min(i + chunkSize, signatures.length)}`);
    }
    console.log('FINAL signature need handle: ', transNotInOrder.length);
    const trans = transNotInOrder;
    const programId = new PublicKey(this.PROGRAM_ID);
    const provider = new AnchorProvider(this.connection, new Wallet(Keypair.generate()), {});

    const program = new Program(IDL as Idl, provider);

    const eventParser = new EventParser(programId, new BorshCoder(program.idl));

    await PromisePool.withConcurrency(1)
      .for(trans)
      .process(async (tran) => {
        await this.handleTransaction(tran, eventParser);
      });
  }

  async handleTransaction(tran: any, eventParser: EventParser) {
    const transactionSession = await this.dbConnection.startSession();
    const events = eventParser.parseLogs(tran.meta.logMessages);
    transactionSession.startTransaction();
    const transaction = await this.transactionModel.findOne({ signature: tran.transaction.signatures[0] });
    if (transaction) {
      console.log('CampaignService transaction already exist', transaction.signature);
      return;
    }
    try {
      const newTransaction = new this.transactionModel();
      newTransaction.signature = tran.transaction.signatures[0];
      newTransaction.block = tran.slot;
      newTransaction.blockTime = tran.blockTime;
      console.log('Received events:', events);
      for (const event of events) {
        console.log(`Processing event: ${event.name}`);
        if (event.name === CampaignEvent.createdCampaignEvent) {
          console.log(`Processing createdCampaignEvent with data:`, event.data);
          await this.handleCreatedCampaignEvent(event.data, transactionSession);
        }
        if (event.name === CampaignEvent.createdCampaignTokenEvent) {
          await this.handleCreatedCampaignTokenEvent(event.data, transactionSession);
        }
        if (event.name === CampaignEvent.soldCampaignTokenEvent) {
          await this.handleSoldCampaignTokenEvent(event.data, transactionSession);
        }
        if (event.name === CampaignEvent.claimableTokenAmountUpdatedEvent) {
          await this.handleClaimableTokenAmountUpdatedEvent(event.data, transactionSession);
        }
        if (event.name === CampaignEvent.claimedTokenEvent) {
          await this.handleClaimedTokenEvent(event.data, transactionSession);
        }
        if (event.name === CampaignEvent.claimedFundEvent) {
          await this.handleClaimedFundEvent(event.data, transactionSession);
        }
        // Note: donatedFundEvent is handled by fund-updater service directly from blockchain
        // to avoid write conflicts between event-based and blockchain-based updates
      }
      await newTransaction.save({ session: transactionSession });
      await transactionSession.commitTransaction();

    } catch (e) {
      console.error('error handle transaction', e);
      await transactionSession.abortTransaction();
    } finally {
      await transactionSession.endSession();
    }
  }

  async handleCreatedCampaignEvent(data: any, session) {
    // Parse campaign index from hex string
    const eventCampaignIndex = parseInt(data.campaignIndex.toString(), 16);
    
    // Smart contract uses 0-based indexing, so store 0-based index in database for consistency
    const campaignIndex = eventCampaignIndex - 1;

    const campaign = new this.campaignModel();
    campaign.creator = data.creator.toString();
    campaign.campaignIndex = campaignIndex; // Store 0-based index for consistency with smart contract
    campaign.name = data.name.toString();
    campaign.symbol = data.symbol.toString();
    campaign.uri = data.uri.toString();
    campaign.donationGoal = Number(ethers.utils.formatUnits(data.donationGoal.toString(), 9).toString());
    campaign.depositDeadline = data.depositDeadline.toString();
    campaign.tradeDeadline = data.tradeDeadline.toString();
    campaign.timestamp = data.timestamp.toString();
    campaign.mint = data.mint;
    
    /// Derive Campaign PDA - use stored 0-based index directly
    const creatorAddress = new PublicKey(data.creator);
    const campaignIndexBN = new BN(campaignIndex);
    const campaignIndexBuffer = Buffer.from(campaignIndexBN.toArray("le", 8));
    
    console.log(`Deriving PDA for creator: ${data.creator.toString()}, event campaignIndex: ${eventCampaignIndex}, stored index: ${campaignIndex}`);
    
    const [campaignPDA, _] = PublicKey.findProgramAddressSync(
      [Buffer.from("campaign"), creatorAddress.toBuffer(), campaignIndexBuffer],
      new PublicKey(this.PROGRAM_ID)
    );

    console.log(`Derived campaignPDA: ${campaignPDA.toString()}`);

    // Fetch Campaign Account Info
    const campaignInfo = await this.connection.getAccountInfo(campaignPDA);
    if (!campaignInfo) {
      throw new Error(`Campaign account not found for PDA: ${campaignPDA.toString()}. Creator: ${data.creator.toString()}, Event Index: ${eventCampaignIndex}, Stored Index: ${campaignIndex}`);
    }

    // Calculate Total Fund Raised
    const minimumRentExemption = await this.connection.getMinimumBalanceForRentExemption(campaignInfo.data.length);
    const totalFundRaised = campaignInfo.lamports - minimumRentExemption;

    campaign.totalFundRaised = totalFundRaised;

    await campaign.save({ session });
  }

  async handleClaimedFundEvent(data: any, transactionSession: any) {
    // Parse campaign index from hex string and convert to 0-based for database consistency
    const eventCampaignIndex = parseInt(data.campaignIndex.toString(), 16);
    const campaignIndex = eventCampaignIndex - 1;
    
    await this.campaignModel.findOneAndUpdate(
      {
        creator: data.creator.toString(),
        campaignIndex: campaignIndex,
      },
      {
        totalFundRaised: 0,
      },
      { session: transactionSession }
    )
  }

  async checkAndUpdateCampaignStatus(campaign: any, session) {
    try {
      // First check if campaign is already COMPLETED
      const existingProcess = await this.addTokenPumpProcessModel.findOne({
        creator: campaign.creator,
        campaignIndex: campaign.campaignIndex
      });

      if (existingProcess?.status === AddTokenProcessStatus.COMPLETED) {
        console.log(`Campaign ${campaign.campaignIndex} is already COMPLETED - skipping status update`);
        return existingProcess;
      }
  
      const now = Math.floor(Date.now() / 1000);
  
      // Status checks with logging
      const isPending = (
        (campaign.totalFundRaised / 1e9).toFixed(2) >= campaign.donationGoal &&
        campaign.depositDeadline >= now
      ) && !campaign.mint;

      const isCompleted = campaign.mint;
  
      const isFailed = !campaign.mint && (
        (campaign.totalFundRaised / 1e9).toFixed(2) < campaign.donationGoal &&
        campaign.depositDeadline <= now
      );
  
      const isRaising = (
        (campaign.totalFundRaised / 1e9).toFixed(2) < campaign.donationGoal &&
        campaign.depositDeadline > now
      ) && !campaign.mint;
  
      let status = AddTokenProcessStatus.RAISING;
      if (isPending) status = AddTokenProcessStatus.PENDING;
      if (isFailed) status = AddTokenProcessStatus.FAILED;
      if (isCompleted) status = AddTokenProcessStatus.COMPLETED;
  
      const result = await this.addTokenPumpProcessModel.findOneAndUpdate(
        {
          creator: campaign.creator,
          campaignIndex: campaign.campaignIndex,
        },
        { 
          status,
          updatedAt: Date.now()
        },
        { 
          upsert: true, 
          session,
          new: true,
          setDefaultsOnInsert: true
        }
      );
  
      console.log(`Updated campaign ${campaign.campaignIndex} to status: ${status}`);
      return result;
  
    } catch (err) {
      console.error(`Error updating campaign ${campaign.campaignIndex}:`, err);
      throw err;
    }
  }

  // TypeScript
  async syncAllCampaignStatuses(session) {
    const campaigns = await this.campaignModel.find();
    for (const campaign of campaigns) {
      await this.checkAndUpdateCampaignStatus(campaign, session);
    }
  }
  
  async handleCreatedCampaignTokenEvent(data: any, session) {
    try {
      // Debug: Log the received data structure
      console.log('CreatedCampaignTokenEvent data:', JSON.stringify(data, null, 2));
      
      // Parse campaign index from hex string (this gives us the database campaign index directly)
      const campaignIndex = parseInt(data.campaignIndex.toString(), 16);
      
      console.log(`Event campaignIndex (hex): ${data.campaignIndex.toString()}, parsed (decimal): ${campaignIndex}`);
      console.log(`Searching for campaign - creator: ${data.creator.toString()}, campaignIndex: ${campaignIndex}`);
      
      // Try to find campaign with the parsed index
      let campaign = await this.campaignModel.findOne({
        creator: data.creator.toString(),
        campaignIndex: campaignIndex,
      });
    
      if (!campaign) {
        console.log(`Campaign not found for creator: ${data.creator.toString()}, campaignIndex: ${campaignIndex}`);
        
        // Debug: Let's see what campaigns exist in the database
        const allCampaigns = await this.campaignModel.find({
          creator: data.creator.toString()
        }).limit(10);
        console.log(`Found ${allCampaigns.length} campaigns for creator ${data.creator.toString()}:`);
        allCampaigns.forEach(c => {
          console.log(`  - Campaign Index: ${c.campaignIndex}, Mint: ${c.mint || 'None'}`);
        });
        
        return;
      }
    
      // Update both campaign and process status atomically to avoid race conditions
      await Promise.all([
        // Update campaign with mint
        this.campaignModel.findOneAndUpdate(
          {
            creator: data.creator.toString(),
            campaignIndex: campaignIndex,
          },
          {
            mint: data.mint.toString(),
          },
          { upsert: true, new: true, session: session }
        ),
        // Update process status to COMPLETED
        this.addTokenPumpProcessModel.findOneAndUpdate(
          {
            creator: data.creator.toString(),
            campaignIndex: campaignIndex,
          },
          {
            status: AddTokenProcessStatus.COMPLETED,
            mint: data.mint.toString(),
          },
          { upsert: true, new: true, session: session }
        )
      ]);

      console.log(`Campaign ${campaignIndex} token created and marked as COMPLETED with mint: ${data.mint.toString()}`);
      
    } catch (error) {
      console.error('Error handling created and bought token event:', error);
      throw error;
    }
  }

  async handleSoldCampaignTokenEvent(data: any, transactionSession: any) {
    try {
      // Parse campaign index from hex string - database uses 1-based indexing
      const campaignIndex = parseInt(data.campaignIndex.toString(), 16);
      
      // Delete from all relevant schemas
      await Promise.all([
        // Delete from campaign model
        this.campaignModel.deleteOne({
          creator: data.creator.toString(),
          campaignIndex: campaignIndex
        }, { session: transactionSession }),
  
        // Delete from token process model 
        this.addTokenPumpProcessModel.deleteOne({
          creator: data.creator.toString(),
          campaignIndex: campaignIndex
        }, { session: transactionSession }),
  
        // Delete from sell progress model
        this.sellProgressModel.deleteOne({
          creator: data.creator.toString(),
          campaignIndex: campaignIndex
        }, { session: transactionSession })
      ]);
  
      console.log(`Deleted campaign ${campaignIndex} after SellTokenEvent`);
  
    } catch (error) {
      console.error('Error handling sell token event:', error);
      throw error;
    }
  }

  async monitorMarketCap(campaign: any, session: any) {
    const wallet = new Wallet(this.operatorKeyPair);
    const provider = new AnchorProvider(this.connection, wallet);
    const program = new Program(IDL as Idl, provider);
    const tx = new Transaction();

    // Ensure consistent PDA derivation
    const campaignIndexBN = new BN(campaign.campaignIndex);
    const [campaignPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("campaign"), new PublicKey(campaign.creator).toBuffer(), Buffer.from(campaignIndexBN.toArray("le", 8))],
      new PublicKey(this.PROGRAM_ID)
    )

    const [configPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      new PublicKey(this.PROGRAM_ID)
    );

    const campaignData = await this.connection.getAccountInfo(campaignPDA);


    let claimAmount = new BN(0);
    let marketCapNumber = 0;

    try {
      const response = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${campaignData.mint}`);
      const data = await response.json() as GeckoResponse;
      const marketCap = data.data.attributes.market_cap_usd;
      marketCapNumber = parseFloat(marketCap);
      const totalBoughtAmount = campaignData.totalTokenBought;

      if (marketCapNumber >= 5_000_000) {
        // For $5M+ market cap, claim 20%
        claimAmount = totalBoughtAmount.muln(20).divn(100);
      } else if (marketCapNumber >= 2_000_000) {
        // For $2M+ market cap, claim 40%
        claimAmount = totalBoughtAmount.muln(40).divn(100);
      } else if (marketCapNumber >= 1_000_000) {
        // For $1M+ market cap, claim 30%
        claimAmount = totalBoughtAmount.muln(30).divn(100);
      } else if (marketCapNumber >= 500_000) {
        // For $500k+ market cap, claim 10%
        claimAmount = totalBoughtAmount.muln(10).divn(100);
      }

      // Ensure we don't claim more than what's available
      const remainingToClaim = totalBoughtAmount.sub(campaignData.totalClaimed);
      if (claimAmount.gt(remainingToClaim)) {
        claimAmount = remainingToClaim;
      }
    } catch (error) {
      console.error("Error fetching token data:", error);
      return null;
    }

    tx.add(await program.methods.updateClaimableAmount(claimAmount).accounts({
      operator: this.operatorKeyPair.publicKey,
      config: configPDA,
      campaignAccount: campaignPDA,
      creator: new PublicKey(campaign.creator),
      mint: new PublicKey(campaignData.mint),
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
    }).instruction());

    return {
      transaction: tx,
      marketCap: marketCapNumber
    }
  }

  async handleClaimableTokenAmountUpdatedEvent(data: any, transactionSession: any) {
    try {
      // Parse campaign index from hex string - database uses 1-based indexing
      const campaignIndex = parseInt(data.campaignIndex.toString(), 16);
      
      const campaign = await this.campaignModel.findOne({
        creator: data.creator.toString(),
        campaignIndex: campaignIndex,
      })

      if (!campaign) {
        console.log('Campaign not found');
        return;
      }

      const marketCapResult = await this.monitorMarketCap(campaign, transactionSession);

      const sellProgress = await this.sellProgressModel.findOne({
        creator: data.creator.toString(),
        campaignIndex: campaignIndex,
      });
  
      if (!sellProgress) {
        console.log('Campaign not found');
        return;
      }
  
      await this.sellProgressModel.findOneAndUpdate(
        {
          creator: data.creator.toString(),
          campaignIndex: campaignIndex,
        },
        {
          claimable_amount: Number(ethers.utils.formatUnits(data.claimable_amount.toString(), 9)),
          mint: data.mint.toString(),
          market_cap: marketCapResult.marketCap,
        },
        { session: transactionSession }
      );
    } catch (error) {
      console.error("Error updating claimable amount:", error);
      throw error;
    }
  }

  async handleClaimedTokenEvent(data: any, transactionSession: any) {
    try {
      // Parse campaign index from hex string - database uses 1-based indexing
      const campaignIndex = parseInt(data.campaignIndex.toString(), 16);
      
      const sellProgress = await this.sellProgressModel.findOne({
        creator: data.creator.toString(),
        campaignIndex: campaignIndex
      });

      if (!sellProgress) {
        throw new Error('No sold out campaign found');
      }

      await this.sellProgressModel.findOneAndUpdate(
        {creator: data.creator.toString(), campaignIndex: campaignIndex},
        {
          claimable_amount: Number(data.amount.toString())
        },
        { session: transactionSession }
      );
    } catch (error) {
      console.error('Error handling claimed token event:', error);
      throw error;
    }
  }

  async handleDonatedFundEvent(data: any, session) {
    try {
      // Debug: Log the received data structure
      console.log('DonatedFundEvent data:', JSON.stringify(data, null, 2));
      
      // Defensive check for required properties (using correct field names from IDL)
      if (!data.campaignIndex) {
        console.error('Missing campaignIndex in donatedFundEvent data');
        return;
      }
      if (!data.donatedAmount) {
        console.error('Missing donatedAmount in donatedFundEvent data');
        return;
      }
      if (!data.timestamp) {
        console.error('Missing timestamp in donatedFundEvent data');
        return;
      }
      
      // Convert campaignIndex and donatedAmount to proper numbers
      // Parse campaign index from hex string - database uses 1-based indexing
      const campaignIndex = parseInt(data.campaignIndex.toString(), 16);
      const donatedAmount = Number(data.donatedAmount.toString());
      const timestamp = data.timestamp.toString();
      
      console.log(`Processing donation of ${donatedAmount / 1e9} SOL to campaign index ${campaignIndex}`);
      
      // Find the campaign by campaignIndex
      const campaign = await this.campaignModel.findOne({ campaignIndex: campaignIndex });
      
      if (!campaign) {
        console.log(`Campaign with index ${campaignIndex} not found`);
        return;
      }
      
      // Update the campaign's totalFundRaised field
      const updatedCampaign = await this.campaignModel.findOneAndUpdate(
        { campaignIndex: campaignIndex },
        { 
          $inc: { totalFundRaised: donatedAmount },
          $set: { lastDonationTimestamp: timestamp }
        },
        { new: true, session }
      );
      
      console.log(`Updated campaign ${campaignIndex} - new total fund raised: ${updatedCampaign.totalFundRaised / 1e9} SOL`);
      
      // Check and update campaign status after donation
      await this.checkAndUpdateCampaignStatus(updatedCampaign, session);
    } catch (error) {
      console.error('Error handling donated fund event:', error);
      throw error;
    }
  }
}
