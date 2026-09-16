"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Force le compte admin en plan pro_max.
 *
 * Nécessaire pour les comptes admin créés AVANT ce correctif : ils étaient
 * enregistrés en plan 'trial', ce qui bloquait la mise en ligne, la création
 * de logo et l'Espace Agence — le rôle 'admin' ne donne que les crédits
 * illimités, pas le contournement des restrictions de plan.
 *
 * Usage : npm run fix:admin
 */
const mongoose_1 = __importDefault(require("mongoose"));
require("dotenv/config");
const User_1 = require("../src/models/User");
async function main() {
    const uri = process.env.MONGODB_URI;
    const adminEmail = process.env.ADMIN_EMAIL;
    if (!uri) {
        console.error('❌ MONGODB_URI manquant.');
        process.exit(1);
    }
    if (!adminEmail) {
        console.error('❌ ADMIN_EMAIL manquant.');
        process.exit(1);
    }
    await mongoose_1.default.connect(uri);
    const res = await User_1.User.updateMany({ $or: [{ email: adminEmail.toLowerCase() }, { role: 'admin' }] }, { $set: { plan: 'pro_max' }, $unset: { trialEndsAt: '' } });
    console.log(`✔ ${res.modifiedCount} compte(s) admin passé(s) en pro_max.`);
    const admins = await User_1.User.find({ role: 'admin' }).select('email plan').lean();
    for (const a of admins)
        console.log(`   ${a.email} → ${a.plan}`);
    await mongoose_1.default.disconnect();
    process.exit(0);
}
main().catch((e) => { console.error('❌', e); process.exit(1); });
//# sourceMappingURL=fix-admin-plan.js.map