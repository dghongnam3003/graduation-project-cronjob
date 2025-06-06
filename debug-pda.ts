import { Connection, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
require("dotenv").config();

async function debugPDADerivation() {
  const connection = new Connection(process.env.RPC || 'https://api.devnet.solana.com');
  const PROGRAM_ID = 'GwAWdhc8NuRVCRn4guyXz7UGaQHCwnnVppBKMtZmxVM2';
  
  // Test data from the failing event
  const creator = new PublicKey('7j51UYKocyVgDAjVyjWa7FhaWVKJvnXZ4Xj4i3Y9QV45');
  const campaignIndex = 2;
  
  console.log(`Debugging PDA derivation for:`);
  console.log(`Creator: ${creator.toString()}`);
  console.log(`Campaign Index: ${campaignIndex}`);
  console.log(`Program ID: ${PROGRAM_ID}`);
  console.log('---');
  
  // Method 1: Our current approach (BN to little-endian 8-byte buffer)
  const campaignIndexBN = new BN(campaignIndex);
  const campaignIndexBuffer = Buffer.from(campaignIndexBN.toArray("le", 8));
  
  const [pda1] = PublicKey.findProgramAddressSync(
    [Buffer.from("campaign"), creator.toBuffer(), campaignIndexBuffer],
    new PublicKey(PROGRAM_ID)
  );
  
  console.log(`Method 1 (BN -> LE 8-byte): ${pda1.toString()}`);
  const info1 = await connection.getAccountInfo(pda1);
  console.log(`Account exists: ${!!info1}`);
  
  // Method 2: Direct number to little-endian buffer
  const buffer2 = Buffer.alloc(8);
  buffer2.writeUInt32LE(campaignIndex, 0);
  
  const [pda2] = PublicKey.findProgramAddressSync(
    [Buffer.from("campaign"), creator.toBuffer(), buffer2],
    new PublicKey(PROGRAM_ID)
  );
  
  console.log(`Method 2 (Direct LE): ${pda2.toString()}`);
  const info2 = await connection.getAccountInfo(pda2);
  console.log(`Account exists: ${!!info2}`);
  
  // Method 3: Big-endian approach
  const buffer3 = Buffer.alloc(8);
  buffer3.writeUInt32BE(campaignIndex, 4);
  
  const [pda3] = PublicKey.findProgramAddressSync(
    [Buffer.from("campaign"), creator.toBuffer(), buffer3],
    new PublicKey(PROGRAM_ID)
  );
  
  console.log(`Method 3 (BE): ${pda3.toString()}`);
  const info3 = await connection.getAccountInfo(pda3);
  console.log(`Account exists: ${!!info3}`);
  
  // Method 4: Just the index as a single byte
  const buffer4 = Buffer.from([campaignIndex]);
  
  const [pda4] = PublicKey.findProgramAddressSync(
    [Buffer.from("campaign"), creator.toBuffer(), buffer4],
    new PublicKey(PROGRAM_ID)
  );
  
  console.log(`Method 4 (Single byte): ${pda4.toString()}`);
  const info4 = await connection.getAccountInfo(pda4);
  console.log(`Account exists: ${!!info4}`);
  
  // Method 5: Try with campaignIndex - 1 (0-based vs 1-based indexing)
  const campaignIndexMinus1 = campaignIndex - 1;
  const bufferMinus1 = Buffer.from(new BN(campaignIndexMinus1).toArray("le", 8));
  
  const [pda5] = PublicKey.findProgramAddressSync(
    [Buffer.from("campaign"), creator.toBuffer(), bufferMinus1],
    new PublicKey(PROGRAM_ID)
  );
  
  console.log(`Method 5 (Index - 1): ${pda5.toString()}`);
  const info5 = await connection.getAccountInfo(pda5);
  console.log(`Account exists: ${!!info5}`);
  
  // Let's also try to find all accounts owned by the program related to this creator
  console.log('\n--- Searching for all program accounts related to this creator ---');
  try {
    const programAccounts = await connection.getProgramAccounts(new PublicKey(PROGRAM_ID), {
      filters: [
        {
          memcmp: {
            offset: 8, // Skip discriminator
            bytes: creator.toBase58(),
          },
        },
      ],
    });
    
    console.log(`Found ${programAccounts.length} program accounts for this creator:`);
    programAccounts.forEach((account, index) => {
      console.log(`  Account ${index + 1}: ${account.pubkey.toString()}`);
      console.log(`    Lamports: ${account.account.lamports}`);
      console.log(`    Data length: ${account.account.data.length}`);
    });
  } catch (e) {
    console.log(`Error searching program accounts: ${e}`);
  }
}

debugPDADerivation().catch(console.error);
