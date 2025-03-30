import mongoose, { Schema, Document } from 'mongoose';

export interface ISellProgress extends Document {
  creator: string;
  campaignIndex: number;
  market_cap: number;
  createdAt: number;
  updatedAt: number;
}

class SellProgressSchema {
  private static model: mongoose.Model<ISellProgress>;

  private constructor() { }

  public static getModel(): mongoose.Model<ISellProgress> {
    if (!SellProgressSchema.model) {
      const schema = new Schema(
        {
          creator: { type: String, required: true },
          campaignIndex: { type: Number, required: true },
          mint: { type: String, required: true },
          claimable_amount: { type: Number, required: true },
          market_cap: { type: Number, required: true, default: 0 },
        },
        { timestamps: true }
      );

      SellProgressSchema.model = mongoose.model<ISellProgress>('sell_token_progress', schema);
    }

    return SellProgressSchema.model;
  }
}

export default SellProgressSchema;