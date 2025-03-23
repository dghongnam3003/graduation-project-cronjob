import mongoose, { Schema, Document } from 'mongoose';

export interface ICampaign extends Document {
  creator: string;
  campaignIndex: number;
  name: string;
  symbol: string;
  uri: string;
  donationGoal: number;
  depositDeadline: number;
  tradeDeadline: number;
  timestamp: number;
}

class CampaignSchema {
  private static model: mongoose.Model<ICampaign>;

  private constructor() { }

  public static getModel(): mongoose.Model<ICampaign> {
    if (!CampaignSchema.model) {
      const schema = new Schema(
        {
          creator: { type: String, required: true },
          campaignIndex: { type: Number, required: true },
          name: { type: String, required: false },
          symbol: { type: String, required: false },
          uri: { type: String, required: false },
          donationGoal: { type: Number, required: false },
          depositDeadline: { type: Number, required: false },
          tradeDeadline: { type: Number, required: false },
          timestamp: { type: Number, required: false }
        },
        { timestamps: true }
      );

      CampaignSchema.model = mongoose.model<ICampaign>('Campaign', schema);
    }

    return CampaignSchema.model;
  }
}

export default CampaignSchema;