import DB from "../../db/db";
import {
  SetupInterface,
} from "../../interfaces";
import { 
  Connection, 
  PublicKey, 
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  Keypair,
  LAMPORTS_PER_SOL
} from "@solana/web3.js";
import { Model, Connection as DbConnection } from 'mongoose';

import CampaignSchema, { ICampaign } from "../../db/schema/campaign.schema";
import AddTokenPumpProcessSchema, {AddTokenProcessStatus, IAddTokenPumpProcess} from "../../db/schema/token-process.schema";
import { AnchorProvider, BN, Idl, Program, Wallet } from '@coral-xyz/anchor';
import { FinalProject } from '../idl/final_project';
import IDL from '../idl/final_project.json';
import PumpFunIDL from '../idl/pump-fun.json';
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { findMetadataPda, MPL_TOKEN_METADATA_PROGRAM_ID } from "@metaplex-foundation/mpl-token-metadata";
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { publicKey } from "@metaplex-foundation/umi";
import { 
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction
} from "@solana/spl-token";

require("dotenv").config();

export default class TokenCreatorService {
  private db: DB;
  private static instance: TokenCreatorService;
  private isSyncing: boolean = false;
  private devnet = false;
  private rpc: string;
  private PROGRAM_ID: string = 'GwAWdhc8NuRVCRn4guyXz7UGaQHCwnnVppBKMtZmxVM2';

  private connection: Connection;
  private dbConnection: DbConnection;
  // Models
  private campaignModel: Model<ICampaign>;
  private addTokenPumpProcessModel: Model<IAddTokenPumpProcess>;

  private operatorKeyPair = Keypair.fromSecretKey(bs58.decode(process.env.OPERATOR_PRIV_KEY || ""));

  // Pump.fun constants
  private pumpFunGlobal: PublicKey;
  private pumpFunFeeRecipient: PublicKey;
  private pumpFunMintAuthority = new PublicKey("TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM");
  private pumpFunEventAuthority = new PublicKey("Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1");
  private pumpFunProgramId = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

  public async setup(setup: SetupInterface) {
    this.db = setup._db;
    this.rpc = setup.rpc;
    this.devnet = setup.devnet;

    // Setup pump.fun constants based on network
    this.pumpFunGlobal = new PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf");
    this.pumpFunFeeRecipient = this.devnet
      ? new PublicKey("68yFSZxzLWJXkxxRGydZ63C6mHx1NLEDWmwN9Lb5yySg")
      : new PublicKey("CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM");

    // Setup connection
    this.connection = new Connection(setup.rpc);
    // Setup db
    this.dbConnection = await this.db.getConnection();
    this.campaignModel = CampaignSchema.getModel();
    this.addTokenPumpProcessModel = AddTokenPumpProcessSchema.getModel();
  }

  public static getInstance(): TokenCreatorService {
    if (!TokenCreatorService.instance) {
      TokenCreatorService.instance = new TokenCreatorService();
    }
    return TokenCreatorService.instance;
  }

  // Main fetch method - called from fetch.ts
  async fetch() {
    if (this.isSyncing) return;
    this.isSyncing = true;

    const MAX_RETRIES = 3;
    let retryCount = 0;

    while (retryCount < MAX_RETRIES) {
      try {
        console.log("Token Creator check start");
        const session = await this.dbConnection.startSession();

        try {
          session.startTransaction();

          // Find and process pending campaigns
          await this.processPendingCampaigns(session);

          await session.commitTransaction();
          this.isSyncing = false;
          return;

        } catch (e) {
          await session.abortTransaction();
          throw e;
        } finally {
          await session.endSession();
        }

      } catch (e) {
        if (e.code === 112) { // WriteConflict error code
          retryCount++;
          console.log(`Token Creator retry attempt ${retryCount} due to write conflict`);
          await new Promise(resolve => setTimeout(resolve, 1000));
        } else {
          console.log('TokenCreatorService fetch error:', e);
          break;
        }
      }
    }

    this.isSyncing = false;
    if (retryCount === MAX_RETRIES) {
      console.log('Token Creator: Max retries reached for handling write conflicts');
    }
  }

  async processPendingCampaigns(session) {
    try {
      // Find campaigns with PENDING status
      const pendingProcesses = await this.addTokenPumpProcessModel.find({
        status: AddTokenProcessStatus.PENDING
      }).limit(5); // Process max 5 at a time to avoid overload

      console.log(`Found ${pendingProcesses.length} pending campaigns for token creation`);

      for (const process of pendingProcesses) {
        try {
          // Get campaign details
          const campaign = await this.campaignModel.findOne({
            creator: process.creator,
            campaignIndex: process.campaignIndex
          });

          if (!campaign) {
            console.log(`Campaign not found for pending process: ${process.creator}, ${process.campaignIndex}`);
            continue;
          }

          // Double-check campaign eligibility
          if (!this.isCampaignEligibleForTokenCreation(campaign)) {
            console.log(`Campaign ${campaign.campaignIndex} no longer eligible for token creation`);
            continue;
          }

          // Mark as processing to prevent duplicate processing
          // await this.addTokenPumpProcessModel.findOneAndUpdate(
          //   {
          //     creator: process.creator,
          //     campaignIndex: process.campaignIndex
          //   },
          //   {
          //     status: AddTokenProcessStatus.PROCESSING,
          //     updatedAt: Date.now()
          //   },
          //   { session }
          // );

          // Create token
          await this.createTokenForCampaign(campaign, session);

        } catch (error) {
          console.error(`Error processing campaign ${process.campaignIndex}:`, error);
          
          // Mark as failed
          await this.addTokenPumpProcessModel.findOneAndUpdate(
            {
              creator: process.creator,
              campaignIndex: process.campaignIndex
            },
            {
              status: AddTokenProcessStatus.FAILED,
              updatedAt: Date.now()
            },
            { session }
          );
        }
      }

    } catch (error) {
      console.error('Error processing pending campaigns:', error);
      throw error;
    }
  }

  private isCampaignEligibleForTokenCreation(campaign: ICampaign): boolean {
    const now = Math.floor(Date.now() / 1000);
    
    return (
      (campaign.totalFundRaised / 1e9) >= campaign.donationGoal &&
      campaign.depositDeadline >= now &&
      !campaign.mint
    );
  }

  async createTokenForCampaign(campaign: ICampaign, session) {
    try {
      console.log(`Creating token for campaign ${campaign.campaignIndex}`);

      const wallet = new Wallet(this.operatorKeyPair);
      const provider = new AnchorProvider(this.connection, wallet);
      const program = new Program<FinalProject>(IDL as FinalProject, provider);
      const pumpFunProgram = new Program(PumpFunIDL as Idl, provider);

      const creatorAddress = new PublicKey(campaign.creator);
      const campaignIndexBN = new BN(campaign.campaignIndex - 1); // Convert to 0-based for PDA
      const slippage = 200; // 2% slippage

      // Derive PDAs
      const [config] = PublicKey.findProgramAddressSync(
        [Buffer.from("config")],
        program.programId
      );

      const [treasury] = PublicKey.findProgramAddressSync(
        [Buffer.from("treasury")],
        program.programId
      );

      const [campaignPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from("campaign"), creatorAddress.toBuffer(), Buffer.from(campaignIndexBN.toArray("le", 8))],
        program.programId
      );

      // Generate new mint keypair
      const mintKeypair = Keypair.generate();
      const mint = mintKeypair.publicKey;

      console.log(`Generated mint: ${mint.toBase58()} for campaign ${campaign.campaignIndex}`);

      // Pump.fun related PDAs
      const [bondingCurve] = PublicKey.findProgramAddressSync(
        [Buffer.from("bonding-curve"), mint.toBuffer()],
        pumpFunProgram.programId
      );

      const associatedBondingCurve = getAssociatedTokenAddressSync(mint, bondingCurve, true);
      const associatedSigner = getAssociatedTokenAddressSync(mint, this.operatorKeyPair.publicKey);
      const associatedCampaign = getAssociatedTokenAddressSync(mint, campaignPDA, true);

      // Metadata PDA
      const umi = createUmi(this.rpc);
      const [metadataString] = findMetadataPda(umi, { mint: publicKey(mint.toBase58()) });
      const metadata = new PublicKey(metadataString);

      // Build transaction
      const tx = new Transaction();

      // 1. Create token instruction
      const createTokenAccounts = {
        operator: this.operatorKeyPair.publicKey,
        config,
        treasury,
        creator: creatorAddress,
        campaignAccount: campaignPDA,
        mint,
        pumpFunMintAuthority: this.pumpFunMintAuthority,
        pumpFunBondingCurve: bondingCurve,
        pumpFunAssociatedBondingCurve: associatedBondingCurve,
        pumpFunGlobal: this.pumpFunGlobal,
        pumpFunEventAuthority: this.pumpFunEventAuthority,
        pumpFunProgram: pumpFunProgram.programId,
        metadata,
        metaplexMetadataProgram: MPL_TOKEN_METADATA_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY
      };

      tx.add(await program.methods.createToken(slippage).accounts(createTokenAccounts).instruction());

      // 2. Calculate buy amounts
      const campaignInfo = await this.connection.getAccountInfo(campaignPDA);
      const campaignBalance = new BN(campaignInfo.lamports);
      const minimumRentExemption = new BN(await this.connection.getMinimumBalanceForRentExemption(campaignInfo.data.length));
      const availableBalance = campaignBalance.sub(minimumRentExemption);
      
      const configData = await program.account.config.fetch(config);
      const fee = availableBalance.mul(new BN(configData.protocolFeePercentage)).div(new BN(10000));
      const maxSolCost = availableBalance.sub(fee);
      
      console.log(`Max SOL cost for buy: ${maxSolCost.toString()}`);
      
      const tokenAmount = this.calcOutTokenAmount(maxSolCost, slippage);

      // 3. Create associated token account for operator
      tx.add(
        createAssociatedTokenAccountInstruction(
          this.operatorKeyPair.publicKey,
          associatedSigner,
          this.operatorKeyPair.publicKey,
          mint
        )
      );

      // 4. Buy tokens from pump.fun
      const pumpFunBuyTokenAccounts = {
        global: this.pumpFunGlobal,
        feeRecipient: this.pumpFunFeeRecipient,
        mint: mint,
        bondingCurve: bondingCurve,
        associatedBondingCurve: associatedBondingCurve,
        associatedUser: associatedSigner,
        user: this.operatorKeyPair.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
        eventAuthority: this.pumpFunEventAuthority,
        program: pumpFunProgram.programId,
      };

      tx.add(await pumpFunProgram.methods.buy(tokenAmount, maxSolCost).accounts(pumpFunBuyTokenAccounts).instruction());

      // 5. Create associated token account for campaign
      tx.add(
        createAssociatedTokenAccountInstruction(
          this.operatorKeyPair.publicKey,
          associatedCampaign,
          campaignPDA,
          mint
        )
      );

      // 6. Transfer tokens to campaign
      tx.add(
        createTransferInstruction(
          associatedSigner,
          associatedCampaign,
          this.operatorKeyPair.publicKey,
          BigInt(tokenAmount.toString())
        )
      );

      // Prepare and send transaction
      tx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;
      tx.feePayer = this.operatorKeyPair.publicKey;

      const recoverTx = Transaction.from(tx.serialize({ requireAllSignatures: false }));
      recoverTx.partialSign(this.operatorKeyPair);
      recoverTx.partialSign(mintKeypair);

      // Send transaction
      const txSignature = await this.connection.sendRawTransaction(
        recoverTx.serialize({ requireAllSignatures: true }),
        {
          skipPreflight: false,
          preflightCommitment: 'confirmed'
        }
      );

      console.log(`Token creation transaction sent: ${txSignature}`);

      // Confirm transaction
      const latestBlockHash = await this.connection.getLatestBlockhash();
      await this.connection.confirmTransaction({
        blockhash: latestBlockHash.blockhash,
        lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
        signature: txSignature,
      });

      console.log(`Token successfully created for campaign ${campaign.campaignIndex}, mint: ${mint.toBase58()}`);

      // Note: The campaign-service.ts will handle the CreatedCampaignTokenEvent
      // and update the campaign with mint address and set status to COMPLETED

    } catch (error) {
      console.error(`Error creating token for campaign ${campaign.campaignIndex}:`, error);
      throw error;
    }
  }

  // Utility function to calculate token output amount (from script)
  private calcOutTokenAmount(solAmount: BN, slippage: number): BN {
    const INITIAL_VIRTUAL_TOKEN_RESERVES = new BN("1073000000000000");
    const INITIAL_VIRTUAL_SOL_RESERVES = new BN("30000000000");
    const INITIAL_REAL_TOKEN_RESERVES = new BN("793100000000000");

    let virtualSolReserves = INITIAL_VIRTUAL_SOL_RESERVES;
    let virtualTokenReserves = INITIAL_VIRTUAL_TOKEN_RESERVES;

    if (solAmount.lte(new BN(0))) {
      return new BN(0);
    }

    let product = virtualSolReserves.mul(virtualTokenReserves);
    let newVirtualSolReserves = virtualSolReserves.add(solAmount);
    let newVirtualTokenReserves = product.div(newVirtualSolReserves).add(new BN(1));
    let tokensOut = virtualTokenReserves.sub(newVirtualTokenReserves);

    // Apply slippage
    let slippageAmount = tokensOut.mul(new BN(slippage)).div(new BN(10000));
    let finalTokensOut = tokensOut.sub(slippageAmount);

    return finalTokensOut;
  }
}