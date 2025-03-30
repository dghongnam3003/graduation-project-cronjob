import mongoose, { Schema, Document } from 'mongoose';

export enum AddTokenProcessStatus {
  RAISING = 'RAISING',
  PENDING = 'PENDING',
  FAILED = 'FAILED',
  COMPLETED = 'COMPLETED',
}

export interface IAddTokenPumpProcess extends Document {
  creator: string;
  campaignIndex: number;
  status: AddTokenProcessStatus;
  createdAt: number;
  updatedAt: number;
}

class AddTokenPumpProcessSchema {
  private static model: mongoose.Model<IAddTokenPumpProcess>;

  private constructor() { }

  public static getModel(): mongoose.Model<IAddTokenPumpProcess> {
    if (!AddTokenPumpProcessSchema.model) {
      const schema = new Schema(
        {
          creator: { type: String, required: true },
          campaignIndex: { type: Number, required: true },
          mint: { type: String, required: false },
          status: { type: String, required: true },
        },
        { timestamps: true }
      );

      AddTokenPumpProcessSchema.model = mongoose.model<IAddTokenPumpProcess>('add_token_pump_processes', schema);
    }

    return AddTokenPumpProcessSchema.model;
  }
}

export default AddTokenPumpProcessSchema;