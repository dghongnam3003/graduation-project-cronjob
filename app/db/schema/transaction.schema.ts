import mongoose, { Schema, Document } from 'mongoose';

export interface ITransaction extends Document {
  signature: string;
  block: number;
  blockTime: number;
}

class TransactionSchema {
  private static model: mongoose.Model<ITransaction>;

  private constructor() { }

  public static getModel(): mongoose.Model<ITransaction> {
    if (!TransactionSchema.model) {
      const schema = new Schema(
        {
          signature: { type: String, required: true, unique: true },
          block: { type: Number, required: true },
          blockTime: { type: Number, required: true },
        },
        { timestamps: true }
      );

      TransactionSchema.model = mongoose.model<ITransaction>('Transaction', schema);
    }

    return TransactionSchema.model;
  }
}

export default TransactionSchema;