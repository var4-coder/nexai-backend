import { Router } from 'express';
import { healthRouter } from './health.routes';
import { authRouter } from './auth.routes';
import { usersRouter } from './users.routes';
import { sitesRouter } from './sites.routes';
import { academyRouter } from './academy.routes';
import { boutiqueRouter } from './boutique.routes';
import { webhooksRouter } from './webhooks.routes';
import { adminRouter } from './admin.routes';
import { logosRouter } from './logos.routes';
import { creditsRouter } from './credits.routes';
import { domainsRouter } from './domains.routes';
import { agencyRouter } from './agency.routes';
import { avisRouter } from './avis.routes';
import { supportRouter } from './support.routes';
import { videoAdsRouter } from './video-ads.routes';
import { publicRouter } from './public.routes';
import { chatRouter } from './chat.routes';
import { retraitRouter } from './retrait.routes';
import { plansRouter } from './plans.routes';
import { textesRouter } from './textes.routes';
import { platformAgentRouter } from './platform-agent.routes';

export const router = Router();

router.use('/health', healthRouter);
router.use('/auth', authRouter);
router.use('/users', usersRouter);
router.use('/chat', chatRouter);
router.use('/sites', sitesRouter);
router.use('/academy', academyRouter);
router.use('/boutique', boutiqueRouter);
router.use('/webhooks', webhooksRouter);
router.use('/admin', adminRouter);
router.use('/logos', logosRouter);
router.use('/credits', creditsRouter);
router.use('/domains', domainsRouter);
router.use('/agency', agencyRouter);
router.use('/avis', avisRouter);
router.use('/support', supportRouter);
router.use('/video-ads', videoAdsRouter);
// Méthode de retrait — page séparée (Architecture v6, section 12)
router.use('/retrait', retraitRouter);
// Abonnements + parrainage (Architecture v6, sections 7 et 16)
router.use('/plans', plansRouter);
// Textes client figés — source unique partagée backend/frontend
router.use('/textes', textesRouter);
// Agent de maintenance externe — jeton dédié, jamais le JWT admin
router.use('/platform-agent', platformAgentRouter);
// Consommé par les sites CLIENTS livrés (autres domaines) — CORS dédié dans app.ts
router.use('/public', publicRouter);
