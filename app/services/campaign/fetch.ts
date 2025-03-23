import DB from "../../db/db";
import {
  SetupInterface,
} from "../../interfaces";
import { Connection, PublicKey } from "@solana/web3.js";
import { Model, Connection as DbConnection, Types } from 'mongoose';

import CampaignSchema, { ICampaign } from "../../db/schema/campaign.schema";
import TransactionSchema, { ITransaction } from "../../db/schema/transaction.schema";
import { AnchorProvider, BorshCoder, Idl, Program, Wallet, EventParser } from '@coral-xyz/anchor';
import IDL from '../idl/final_project.json';
import { PromisePool } from '@supercharge/promise-pool';
import { ethers } from 'ethers';
import { CampaignEvent } from "../../constant";
import { sleep } from "../../utils/sleep";

require("dotenv").config();
const { Keypair } = require('@solana/web3.js');

export default class CampaignService {
  private db: DB;
  private static instance: CampaignService;
  private isSyncing: boolean = false;
  private devnet = false;
  private heliusKey: string;
  private rpc: string;
  private PROGRAM_ID: string = '43sppekvoD25jNTYgbM6auscDht7ZUmwpmmVLwSfcLCW'

  private connection;
  private dbConnection: DbConnection;
  // list models
  private campaignModel: Model<ICampaign>;
  private transactionModel: Model<ITransaction>;

  public async setup(setup: SetupInterface) {
    this.db = setup._db;
    this.rpc = setup.rpc;
    this.devnet = setup.devnet;
    this.heliusKey = setup.heliusKey;

    // Setup connection
    this.connection = new Connection(setup.rpc);
    // Setup db
    this.dbConnection = await this.db.getConnection();
    this.campaignModel = CampaignSchema.getModel();
    this.transactionModel = TransactionSchema.getModel();
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
    try {
      // Check oldest first
      console.log("Fetching campaign start");
      await this.syncNewTransaction();
      this.isSyncing = false;
    } catch (e) {
      console.log('CampaignService fetch error', e);
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
      for (const event of events) {
        if (event.name === CampaignEvent.createdCampaignEvent) {
          await this.handleCreatedCampaignEvent(event.data, transactionSession);
        }
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
    const campaign = new this.campaignModel();
    campaign.creator = data.creator.toString();
    campaign.campaignIndex = Number(data.campaignIndex.toString());
    campaign.name = data.name.toString();
    campaign.symbol = data.symbol.toString();
    campaign.uri = data.uri.toString();
    campaign.donationGoal = Number(ethers.utils.formatUnits(data.donationGoal.toString(), 9).toString());
    campaign.depositDeadline = data.depositDeadline.toString();
    campaign.tradeDeadline = data.tradeDeadline.toString();
    campaign.timestamp = data.timestamp.toString();
    await campaign.save({ session });
  }
}
