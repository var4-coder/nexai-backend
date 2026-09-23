import { Schema, model, Types } from 'mongoose';

export type JobType =
  | 'generation_site'
  | 'repair'
  | 'logo'
  | 'redeploiement'
  | 'modification_bloc'
  | 'modification_structurelle'
  | 'video_ad';

export type JobStatus = 'queued' | 'active' | 'completed' | 'failed';

export interface IJob {
  _id: Types.ObjectId;
  type: JobType;
  siteId: Types.ObjectId;
  status: JobStatus;
  bullJobId: string;
  error?: string;
  meta?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const jobSchema = new Schema<IJob>(
  {
    type: {
      type: String,
      enum: [
        'generation_site',
        'repair',
        'logo',
        'redeploiement',
        'modification_bloc',
        'modification_structurelle',
        'video_ad',
      ],
      required: true,
    },
    siteId: { type: Schema.Types.ObjectId, ref: 'Site', required: true, index: true },
    status: { type: String, enum: ['queued', 'active', 'completed', 'failed'], default: 'queued' },
    bullJobId: { type: String, required: true },
    error: { type: String },
    meta: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

export const Job = model<IJob>('Job', jobSchema);
