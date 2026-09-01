import { Schema, model, Types } from 'mongoose';

export type SupportTicketStatus = 'open' | 'ai' | 'needs_human' | 'closed';
export type SupportMessageRole = 'user' | 'assistant' | 'admin';

export interface ISupportMessage {
  _id?: Types.ObjectId;
  role: SupportMessageRole;
  content: string;
  createdAt: Date;
}

export interface ISupportTicket {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  status: SupportTicketStatus;
  subject?: string;
  messages: ISupportMessage[];
  createdAt: Date;
  updatedAt: Date;
}

const messageSchema = new Schema<ISupportMessage>(
  {
    role: { type: String, enum: ['user', 'assistant', 'admin'], required: true },
    content: { type: String, required: true, trim: true, maxlength: 4000 },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const supportTicketSchema = new Schema<ISupportTicket>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    status: {
      type: String,
      enum: ['open', 'ai', 'needs_human', 'closed'],
      default: 'open',
      index: true,
    },
    subject: { type: String, trim: true },
    messages: { type: [messageSchema], default: [] },
  },
  { timestamps: true }
);

supportTicketSchema.index({ userId: 1, status: 1 });
supportTicketSchema.index({ status: 1, updatedAt: -1 });

supportTicketSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform(_doc, ret: any) {
    ret.id = String(ret._id);
    delete ret._id;
    if (Array.isArray(ret.messages)) {
      ret.messages = ret.messages.map((m: any) => ({
        id: String(m._id || m.id || ''),
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
      }));
    }
    return ret;
  },
});

export const SupportTicket = model<ISupportTicket>('SupportTicket', supportTicketSchema);
