import db from "./db/db";
import CampaignFundService from "./services/campaign/fund-updater";
import CampaignService from "./services/campaign/campaign-service";
import { SetupInterface } from "./interfaces/setup.interface";
require("dotenv").config();

async function runFundUpdateJob() {
  try {
    await CampaignFundService.getInstance().fetch();
  } catch (e) {
    console.log(`UPDATE FUND error`, e);
  }
}

async function runMainJob() {
  try {
    await CampaignService.getInstance().fetch();
  } catch (e) {
    console.log(`CREATE TOKEN error`, e);
  }
}

// cronjob for fund update
const fundLoop = async function () {
  await runFundUpdateJob();
  setTimeout(fundLoop, 15000);
}

// cronjob for create token
const mainLoop = async function () {
  await runMainJob();
  setTimeout(mainLoop, 15000);
}

async function syncHistory() {
  const DB = await db.getInstance();
  await DB.connect();
  const config: SetupInterface = {
    _db: DB,
    rpc: process.env.RPC,
    devnet: process.env.NODE_ENV === 'production' ? false : true
  };
  await CampaignService.getInstance().setup(config);
  await CampaignFundService.getInstance().setup(config);

  // Start token creation first to handle PENDING campaigns
  mainLoop();
  fundLoop();
}

(async () => {
  await syncHistory();
})();
