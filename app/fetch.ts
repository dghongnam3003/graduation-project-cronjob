import db from "./db/db";
import CampaignFundService from "./services/campaign/fund-updater";
import CampaignService from "./services/campaign/campaign-service";
import TokenCreatorService from "./services/campaign/token-creator";
import { SetupInterface } from "./interfaces/setup.interface";
// import db from "./db/db";
require("dotenv").config();

// Global process declaration
declare const process: any;

async function runFundUpdateJob() {
  try {
    const DB = db.getInstance();
    if (!DB.isHealthy()) {
      console.log('Database connection not healthy, skipping fund update job');
      return;
    }
    await CampaignFundService.getInstance().fetch();
  } catch (e) {
    console.log(`UPDATE FUND error`, e);
  }
}

async function runMainJob() {
  try {
    const DB = db.getInstance();
    if (!DB.isHealthy()) {
      console.log('Database connection not healthy, skipping main job');
      return;
    }
    await CampaignService.getInstance().fetch();
  } catch (e) {
    console.log(`CREATE TOKEN error`, e);
  }
}

async function runTokenCreatorJob() {
  try {
    console.log('runTokenCreatorJob called');
    const DB = db.getInstance();
    if (!DB.isHealthy()) {
      console.log('Database connection not healthy, skipping token creator job');
      return;
    }
    console.log('Database healthy, calling TokenCreatorService.fetch()');
    await TokenCreatorService.getInstance().fetch();
  } catch (e) {
    console.log(`TOKEN CREATOR error`, e);
  }
}

// cronjob for fund update
const fundLoop = async function () {
  try {
    await runFundUpdateJob();
  } catch (error) {
    console.error('Fund update loop error:', error);
  }
  setTimeout(fundLoop, 15000);
}

// cronjob for create token
const mainLoop = async function () {
  try {
    await runMainJob();
  } catch (error) {
    console.error('Main loop error:', error);
  }
  setTimeout(mainLoop, 15000);
}

// cronjob for token creator
const tokenLoop = async function () {
  try {
    console.log('tokenLoop iteration starting');
    await runTokenCreatorJob();
  } catch (error) {
    console.error('Token creator loop error:', error);
  }
  setTimeout(tokenLoop, 15000);
}

async function syncHistory() {
  try {
    const DB = await db.getInstance();
    await DB.connect();
    console.log(`Database connection state: ${DB.getConnectionState()}`);
    
    const config: SetupInterface = {
      _db: DB,
      rpc: process.env.RPC,
      devnet: process.env.NODE_ENV === 'production' ? false : true
    };
    await CampaignService.getInstance().setup(config);
    await CampaignFundService.getInstance().setup(config);
    await TokenCreatorService.getInstance().setup(config);    

    console.log('Starting mainLoop...');
    mainLoop();

    console.log('Starting tokenLoop...');
    tokenLoop();
    
    // Add 5 second delay before starting fund update to reduce race conditions
    setTimeout(() => {
      fundLoop();
    }, 5000);
  } catch (error) {
    console.error('Failed to initialize database connection:', error);
    console.log('Retrying database connection in 30 seconds...');
    setTimeout(() => {
      syncHistory();
    }, 30000);
  }
}

// Check if MongoDB service is running
async function checkMongoService() {
  try {
    const DB = db.getInstance();
    await DB.connect();
    console.log('MongoDB service check: OK');
    return true;
  } catch (error) {
    console.error('MongoDB service check failed:', error);
    console.log('Please ensure MongoDB service is running and accessible');
    return false;
  }
}

(async () => {
  // Handle unhandled promise rejections
  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // Don't exit process, just log the error
  });

  // Handle uncaught exceptions
  process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    // Don't exit process, just log the error
  });

  const mongoServiceHealthy = await checkMongoService();
  if (mongoServiceHealthy) {
    await syncHistory();
  }
})();
