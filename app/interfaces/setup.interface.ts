import DB from "../db/db";

export interface SetupInterface {
  _db: DB;
  rpc: string;
  devnet: boolean;
}

