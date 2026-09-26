/**
 * Catalogue de référence de l'Académie NexAI — structure validée le 25/09/2026 :
 *
 *   DOMAINE (22)  →  FORMATION (60, formations proches fusionnées)  →  LEÇONS
 *
 * Chaque formation se découpe en :
 *   · Partie 1 « Les bases »            : vidéo IA « bases » (tirée du résumé)
 *   · Partie 2 « Formation complète »   : Comprendre (vidéo IA complète)
 *                                         Phase pratique (vidéos réelles ou IA)
 *                                         Kit Expert (PDF téléchargeable)
 *
 * Les textes ci-dessous sont les TEXTES DE BASE (écrits une fois, sans coût).
 * Ils sont copiés en base au premier démarrage (voir academy-catalogue-seed)
 * puis modifiables dans l'admin, ou réécrits par Sonnet sur demande. Le code
 * n'écrase jamais un texte déjà modifié.
 *
 * `motsClesImage` : recherche Pexels (en anglais, bien plus de résultats).
 * `logiciel` : formation centrée sur un outil à manipuler → priorité aux
 * vraies vidéos pratiques (l'IA ne montre pas une manipulation d'écran).
 */

export interface AcademyPole {
  slug: string;
  titre: string;
  ordre: number;
}

export interface AcademyFormationDef {
  slug: string;
  titre: string;
  accroche: string;
  description: string;
  /** Ce que la pratique apporte — texte de vente de la Partie 2 */
  pratique: string;
  motsClesImage: string;
  logiciel?: boolean;
}

export interface AcademyModule {
  slug: string;
  titre: string;
  emoji: string;
  pole: string;
  ordre: number;
  accroche: string;
  description: string;
  motsClesImage: string;
  formations: AcademyFormationDef[];
}

export const ACADEMY_POLES: AcademyPole[] = [
  { slug: 'ia-creation', titre: 'IA & Création', ordre: 1 },
  { slug: 'marketing', titre: 'Marketing & Visibilité', ordre: 2 },
  { slug: 'business', titre: 'Vendre & Entreprendre', ordre: 3 },
  { slug: 'tech', titre: 'Tech & Données', ordre: 4 },
  { slug: 'humain', titre: 'Compétences humaines', ordre: 5 },
];

export const ACADEMY_MODULES: AcademyModule[] = [
  // ── Pôle 1 : IA & Création ─────────────────────────────────────────────
  {
    slug: 'ia-prompt',
    titre: 'IA & Prompt Engineering',
    emoji: '🤖',
    pole: 'ia-creation',
    ordre: 1,
    accroche: "Faites de l'IA votre meilleur collaborateur.",
    description:
      "Comprenez comment fonctionnent les assistants IA, apprenez à leur parler pour obtenir des résultats fiables, et intégrez-les dans votre travail de tous les jours.",
    motsClesImage: 'artificial intelligence laptop work',
    formations: [
      {
        slug: 'ia-demarrer',
        titre: "Démarrer avec l'IA et bien la guider",
        accroche: "Passez de « je teste » à « j'obtiens exactement ce que je veux ».",
        description:
          "Ce qu'est vraiment l'IA générative, comment choisir entre ChatGPT, Claude et Gemini, et la méthode pour écrire des consignes (prompts) claires qui donnent des réponses utiles du premier coup.",
        pratique:
          'Des prompts écrits en direct, corrigés et améliorés sous vos yeux, sur des cas de la vie professionnelle.',
        motsClesImage: 'person using chatbot laptop',
      },
      {
        slug: 'ia-productivite',
        titre: "L'IA au travail : productivité et automatisation",
        accroche: 'Gagnez des heures chaque semaine sur vos tâches répétitives.',
        description:
          "Rédaction, résumés, recherche, organisation, analyse de documents avec NotebookLM : les usages concrets de l'IA qui font gagner du temps, et comment les enchaîner.",
        pratique: 'Des routines de travail assistées par IA montées pas à pas, prêtes à reproduire.',
        motsClesImage: 'productive office desk laptop',
      },
      {
        slug: 'ia-contenus-visuels',
        titre: "Créer contenus et visuels avec l'IA",
        accroche: 'Textes, images et idées de contenu en quelques minutes, avec votre style.',
        description:
          "Générer des articles, des publications et des visuels avec l'IA sans perdre votre ton ni votre identité, et savoir retoucher le résultat pour qu'il soit publiable.",
        pratique: "Des créations complètes réalisées de l'idée au résultat final, outil en main.",
        motsClesImage: 'digital art creation tablet',
      },
    ],
  },
  {
    slug: 'video-ia',
    titre: 'Création vidéo & Film IA',
    emoji: '🎬',
    pole: 'ia-creation',
    ordre: 2,
    accroche: 'Des vidéos professionnelles, sans caméra ni studio.',
    description:
      "Écrivez, générez et montez des vidéos avec l'IA : publicités, présentations avec avatar, contenus pour les réseaux et courts métrages.",
    motsClesImage: 'video production creative studio',
    formations: [
      {
        slug: 'video-ia-concevoir',
        titre: 'Concevoir sa vidéo IA : script et storyboard',
        accroche: 'Une bonne vidéo IA commence toujours par un bon plan.',
        description:
          "Trouver l'idée, écrire un script qui retient l'attention et découper la vidéo en plans clairs que l'IA saura générer.",
        pratique: 'Un script et un storyboard construits ensemble, plan par plan.',
        motsClesImage: 'storyboard sketch film planning',
      },
      {
        slug: 'video-ia-avatars-voix',
        titre: 'Avatars, voix et doublage IA',
        accroche: 'Un présentateur et une voix professionnels, à la demande.',
        description:
          "Créer un présentateur virtuel crédible, choisir et régler une voix off, et doubler une vidéo dans une autre langue.",
        pratique: 'Des avatars et des voix configurés en direct, avec les réglages qui font la différence.',
        motsClesImage: 'microphone voice recording studio',
        logiciel: true,
      },
      {
        slug: 'video-ia-pubs-films',
        titre: 'Publicités, vidéos courtes et courts métrages IA',
        accroche: 'Du format réseau de 20 secondes au mini-film.',
        description:
          "Les formats qui marchent sur les réseaux, les règles d'une publicité efficace, et les étapes pour enchaîner plusieurs scènes en un court métrage cohérent.",
        pratique: 'Des vidéos produites de A à Z, avec le montage final.',
        motsClesImage: 'short film camera cinema',
        logiciel: true,
      },
    ],
  },
  {
    slug: 'design',
    titre: 'Design & Identité visuelle',
    emoji: '🎨',
    pole: 'ia-creation',
    ordre: 3,
    accroche: 'Des visuels qui inspirent confiance au premier regard.',
    description:
      "Les règles du design graphique, les logiciels de référence et la création d'une identité visuelle complète pour une marque.",
    motsClesImage: 'graphic designer workspace colors',
    formations: [
      {
        slug: 'design-canva',
        titre: 'Les fondamentaux du design et Canva',
        accroche: 'Réussir ses visuels sans être graphiste.',
        description:
          'Couleurs, typographies, alignements, hiérarchie : les règles qui rendent un visuel professionnel, appliquées avec Canva.',
        pratique: 'Des visuels réalisés sur Canva, du document vide au rendu final.',
        motsClesImage: 'graphic design color palette',
        logiciel: true,
      },
      {
        slug: 'design-adobe',
        titre: 'Photoshop, Illustrator et InDesign',
        accroche: 'Les outils des professionnels, enfin accessibles.',
        description:
          "Retouche et montage photo, dessin vectoriel et mise en page : à quoi sert chaque logiciel et comment s'en servir efficacement.",
        pratique: 'Des projets menés dans chaque logiciel, étape par étape.',
        motsClesImage: 'designer computer creative software',
        logiciel: true,
      },
      {
        slug: 'design-identite',
        titre: 'Identité visuelle, Figma et motion design',
        accroche: 'Une marque reconnaissable partout où elle apparaît.',
        description:
          "Créer un logo et une charte graphique, concevoir des maquettes d'écrans sur Figma et animer ses visuels.",
        pratique: 'Une identité de marque et une maquette construites ensemble sur Figma.',
        motsClesImage: 'brand identity logo design',
        logiciel: true,
      },
    ],
  },
  {
    slug: 'photo',
    titre: 'Photographie pro',
    emoji: '📷',
    pole: 'ia-creation',
    ordre: 4,
    accroche: 'Des photos qui vendent, même avec un smartphone.',
    description:
      'Maîtriser la lumière, le cadrage et la retouche pour produire des photos professionnelles de produits, de personnes et de lieux.',
    motsClesImage: 'photographer camera professional',
    formations: [
      {
        slug: 'photo-bases',
        titre: 'Bien photographier : smartphone, lumière et composition',
        accroche: 'Les réflexes qui transforment une photo banale en belle photo.',
        description:
          "Réglages essentiels, lumière naturelle, règles de composition : tout ce qu'il faut savoir avant d'appuyer sur le déclencheur.",
        pratique: 'Des prises de vue commentées, avant et après correction.',
        motsClesImage: 'smartphone photography natural light',
      },
      {
        slug: 'photo-produit-portrait',
        titre: 'Photo produit et portrait pro',
        accroche: 'Des images qui donnent envie d’acheter et inspirent confiance.',
        description:
          "Mettre en valeur un produit pour une boutique en ligne et réussir des portraits professionnels, avec peu de matériel.",
        pratique: 'Des séances photo complètes, de l’installation au rendu final.',
        motsClesImage: 'product photography studio',
      },
      {
        slug: 'photo-retouche',
        titre: "Retouche photo avec Lightroom et l'IA",
        accroche: 'La touche finale qui fait toute la différence.',
        description:
          "Corriger la lumière et les couleurs, harmoniser une série de photos et utiliser l'IA pour les retouches délicates.",
        pratique: 'Des retouches réalisées en direct sur de vraies photos.',
        motsClesImage: 'photo editing computer screen',
        logiciel: true,
      },
    ],
  },
  {
    slug: 'montage',
    titre: 'Montage vidéo pro',
    emoji: '🎥',
    pole: 'ia-creation',
    ordre: 5,
    accroche: 'Des vidéos rythmées qui retiennent l’attention.',
    description:
      'Monter, habiller et finaliser des vidéos pour le web et les réseaux, de CapCut à Premiere Pro.',
    motsClesImage: 'video editing timeline computer',
    formations: [
      {
        slug: 'montage-capcut',
        titre: 'Monter ses vidéos avec CapCut',
        accroche: 'Le montage accessible à tous, sur téléphone ou ordinateur.',
        description:
          'Couper, assembler, ajouter textes, musique et transitions : toutes les bases du montage avec CapCut.',
        pratique: 'Des montages complets réalisés sous vos yeux dans CapCut.',
        motsClesImage: 'mobile video editing app',
        logiciel: true,
      },
      {
        slug: 'montage-premiere',
        titre: 'Montage pro avec Premiere Pro',
        accroche: 'Passez au niveau des monteurs professionnels.',
        description:
          'Organisation des projets, montage avancé, son, sous-titres, étalonnage et exports dans Premiere Pro.',
        pratique: 'Un projet professionnel monté de bout en bout dans Premiere Pro.',
        motsClesImage: 'professional video editor studio',
        logiciel: true,
      },
      {
        slug: 'montage-reseaux-ia',
        titre: "Vidéos pour les réseaux et montage accéléré par l'IA",
        accroche: 'Plus de vidéos, en moins de temps.',
        description:
          "Les codes des formats verticaux, le rythme qui retient, et les outils IA qui coupent, sous-titrent et recadrent à votre place.",
        pratique: 'Des vidéos verticales produites à la chaîne, avec les bons outils.',
        motsClesImage: 'vertical video smartphone content creator',
        logiciel: true,
      },
    ],
  },
  {
    slug: 'musique',
    titre: 'Production musicale & Audio',
    emoji: '🎵',
    pole: 'ia-creation',
    ordre: 6,
    accroche: 'Du home studio à la diffusion de vos morceaux.',
    description:
      'Composer, enregistrer, mixer et diffuser sa musique, avec un équipement raisonnable et les outils IA.',
    motsClesImage: 'home music studio producer',
    formations: [
      {
        slug: 'musique-production',
        titre: 'Home studio et production musicale',
        accroche: 'Créez vos premiers morceaux chez vous.',
        description:
          "S'équiper sans se ruiner, prendre en main un logiciel de production et composer ses premiers morceaux.",
        pratique: 'Des morceaux construits piste par piste dans un logiciel de production.',
        motsClesImage: 'music production keyboard headphones',
        logiciel: true,
      },
      {
        slug: 'musique-mixage-diffusion',
        titre: 'Mixage, musique IA et diffusion',
        accroche: 'Un son propre, puis un public.',
        description:
          'Les bases du mixage et du mastering, la création musicale assistée par IA, et la diffusion sur les plateformes de streaming.',
        pratique: 'Un morceau mixé, finalisé et préparé pour la diffusion.',
        motsClesImage: 'audio mixing console',
        logiciel: true,
      },
    ],
  },

  // ── Pôle 2 : Marketing & Visibilité ───────────────────────────────────
  {
    slug: 'marketing',
    titre: 'Marketing digital & Publicité',
    emoji: '📣',
    pole: 'marketing',
    ordre: 7,
    accroche: 'Attirez des clients en ligne, chaque jour.',
    description:
      'Construire une stratégie, créer du contenu qui attire, vendre par email et affiliation, et lancer des publicités rentables.',
    motsClesImage: 'digital marketing strategy team',
    formations: [
      {
        slug: 'marketing-strategie-contenu',
        titre: 'Stratégie et marketing de contenu',
        accroche: 'Savoir à qui parler, et quoi lui dire.',
        description:
          'Définir sa cible et son offre, bâtir un plan marketing simple et produire du contenu qui attire des clients.',
        pratique: 'Un plan marketing et un calendrier de contenu construits ensemble.',
        motsClesImage: 'marketing plan whiteboard',
      },
      {
        slug: 'marketing-email-affiliation',
        titre: 'Emailing et marketing d’affiliation',
        accroche: 'Deux leviers qui rapportent, même quand vous dormez.',
        description:
          'Construire une liste email, écrire des newsletters qui vendent, et gagner des commissions en recommandant des produits.',
        pratique: 'Une séquence email et une campagne d’affiliation montées pas à pas.',
        motsClesImage: 'email marketing laptop inbox',
      },
      {
        slug: 'marketing-publicite',
        titre: 'Publicité en ligne : Meta, TikTok et Google',
        accroche: 'Chaque franc investi doit vous rapporter.',
        description:
          'Cibler, créer et piloter des campagnes publicitaires sur Facebook, Instagram, TikTok et Google, et savoir lire leurs résultats.',
        pratique: 'Des campagnes paramétrées en direct dans les gestionnaires de publicité.',
        motsClesImage: 'online advertising analytics dashboard',
        logiciel: true,
      },
      {
        slug: 'marketing-tunnel-mesure',
        titre: 'Tunnel de vente, automatisation et mesure',
        accroche: 'Transformez des visiteurs en clients, automatiquement.',
        description:
          'Construire un tunnel de vente, automatiser les relances et mesurer ce qui fonctionne vraiment.',
        pratique: 'Un tunnel de vente complet construit et connecté, étape par étape.',
        motsClesImage: 'sales funnel conversion chart',
        logiciel: true,
      },
    ],
  },
  {
    slug: 'reseaux',
    titre: 'Réseaux sociaux & Personal Branding',
    emoji: '📱',
    pole: 'marketing',
    ordre: 8,
    accroche: 'Une audience qui vous suit et vous fait confiance.',
    description:
      'Construire son image, publier régulièrement avec une vraie stratégie et transformer ses abonnés en clients.',
    motsClesImage: 'social media smartphone influencer',
    formations: [
      {
        slug: 'reseaux-strategie-branding',
        titre: 'Stratégie, personal branding et LinkedIn',
        accroche: 'Devenez la référence de votre domaine.',
        description:
          'Définir son positionnement, bâtir une image forte, animer une communauté et utiliser LinkedIn pour attirer des opportunités.',
        pratique: 'Un profil et une ligne éditoriale construits et optimisés ensemble.',
        motsClesImage: 'personal branding professional portrait',
      },
      {
        slug: 'reseaux-meta-whatsapp',
        titre: 'Facebook, Instagram et WhatsApp Business',
        accroche: 'Les réseaux où se trouvent vos clients.',
        description:
          'Créer et animer une page, publier du contenu qui engage, et vendre grâce au catalogue et aux messages WhatsApp Business.',
        pratique: 'Des pages et un compte WhatsApp Business configurés et animés en direct.',
        motsClesImage: 'instagram facebook phone business',
        logiciel: true,
      },
      {
        slug: 'reseaux-tiktok-youtube',
        titre: 'TikTok et YouTube : créer et monétiser',
        accroche: 'La vidéo, moteur de croissance numéro un.',
        description:
          'Comprendre les algorithmes, produire des vidéos qui percent, et monétiser sa chaîne ou son compte.',
        pratique: 'Des vidéos pensées, tournées et publiées selon la méthode.',
        motsClesImage: 'youtuber filming vlog camera',
      },
    ],
  },
  {
    slug: 'seo',
    titre: 'SEO & Référencement',
    emoji: '🔍',
    pole: 'marketing',
    ordre: 9,
    accroche: 'Apparaissez sur Google, gratuitement et durablement.',
    description:
      'Comprendre comment Google classe les sites, choisir les bons mots-clés et optimiser son site et ses contenus.',
    motsClesImage: 'search engine optimization laptop',
    formations: [
      {
        slug: 'seo-bases-mots-cles',
        titre: 'Les bases du SEO et les mots-clés',
        accroche: 'Comprendre ce que Google attend de vous.',
        description:
          'Le fonctionnement du référencement naturel et la méthode pour trouver les mots-clés que vos clients tapent vraiment.',
        pratique: 'Une recherche de mots-clés complète menée avec les outils.',
        motsClesImage: 'keyword research computer',
        logiciel: true,
      },
      {
        slug: 'seo-onpage-technique',
        titre: 'SEO on-page, technique et netlinking',
        accroche: 'Un site que Google comprend et recommande.',
        description:
          'Optimiser ses pages et ses textes, corriger les problèmes techniques et obtenir des liens qui renforcent l’autorité du site.',
        pratique: 'Un audit et des corrections réalisés sur un vrai site.',
        motsClesImage: 'website analytics audit',
        logiciel: true,
      },
      {
        slug: 'seo-local-blogging',
        titre: 'SEO local et blogging rentable',
        accroche: 'Soyez trouvé près de chez vous, et grâce à vos articles.',
        description:
          'Apparaître sur Google Maps avec une fiche d’établissement et créer un blog qui attire des visiteurs qualifiés.',
        pratique: 'Une fiche Google et des articles optimisés, construits ensemble.',
        motsClesImage: 'local business map smartphone',
      },
    ],
  },
  {
    slug: 'copywriting',
    titre: 'Copywriting & Création de contenu',
    emoji: '✍️',
    pole: 'marketing',
    ordre: 10,
    accroche: 'Des mots qui font passer à l’action.',
    description:
      'Écrire des pages, des emails et des publications qui captent l’attention, rassurent et donnent envie d’acheter.',
    motsClesImage: 'writer typing laptop coffee',
    formations: [
      {
        slug: 'copywriting-vendre',
        titre: 'Écrire pour vendre : pages et emails',
        accroche: 'Les structures qui convertissent, expliquées simplement.',
        description:
          'Les principes du copywriting, la structure d’une page de vente et l’écriture d’emails qui obtiennent des clics.',
        pratique: 'Une page de vente et des emails rédigés et corrigés ensemble.',
        motsClesImage: 'copywriting notebook desk',
      },
      {
        slug: 'copywriting-storytelling-ia',
        titre: 'Storytelling, réseaux sociaux et IA',
        accroche: 'Racontez des histoires qui marquent.',
        description:
          'Utiliser le storytelling pour votre marque, écrire pour les réseaux et gagner du temps avec l’IA sans perdre votre voix.',
        pratique: 'Des publications et des histoires de marque écrites pas à pas.',
        motsClesImage: 'storytelling creative writing',
      },
    ],
  },

  // ── Pôle 3 : Vendre & Entreprendre ────────────────────────────────────
  {
    slug: 'ecommerce',
    titre: 'Vendre en ligne & E-commerce',
    emoji: '💰',
    pole: 'business',
    ordre: 11,
    accroche: 'Votre boutique ouverte 24 h sur 24.',
    description:
      'Lancer une boutique, vendre sur les places de marché, encaisser en ligne et par Mobile Money, et vendre ses produits numériques.',
    motsClesImage: 'ecommerce online shop packaging',
    formations: [
      {
        slug: 'ecommerce-boutique',
        titre: 'Lancer sa boutique : Shopify et Mobile Money',
        accroche: 'De l’idée à la première commande.',
        description:
          'Choisir ses produits, créer sa boutique sur Shopify, fixer ses prix et accepter les paiements en ligne et par Mobile Money.',
        pratique: 'Une boutique créée et paramétrée de A à Z.',
        motsClesImage: 'online store laptop products',
        logiciel: true,
      },
      {
        slug: 'ecommerce-marketplaces',
        titre: 'Marketplaces et fidélisation',
        accroche: 'Vendre là où les clients achètent déjà, puis les garder.',
        description:
          'Vendre sur Amazon, Etsy et les plateformes locales, gérer le service client et transformer un acheteur en client fidèle.',
        pratique: 'Des fiches produits et un service client mis en place ensemble.',
        motsClesImage: 'customer service package delivery',
      },
      {
        slug: 'ecommerce-numerique',
        titre: 'Vendre ses produits numériques et sa formation',
        accroche: 'Vos connaissances ont de la valeur. Vendez-les.',
        description:
          'Créer un produit numérique ou une formation en ligne, la présenter et la vendre sans stock ni livraison.',
        pratique: 'Un produit numérique créé et mis en vente, étape par étape.',
        motsClesImage: 'online course creator laptop',
      },
    ],
  },
  {
    slug: 'freelance',
    titre: 'Freelance & Vente de services IA',
    emoji: '🚀',
    pole: 'business',
    ordre: 12,
    accroche: 'Vivez de vos compétences digitales.',
    description:
      'Se lancer en indépendant, trouver des clients, fixer ses prix et créer une agence de services digitaux et IA.',
    motsClesImage: 'freelancer working cafe laptop',
    formations: [
      {
        slug: 'freelance-demarrer',
        titre: 'Devenir freelance et fixer ses prix',
        accroche: 'Démarrer sur de bonnes bases, sans se brader.',
        description:
          'Choisir son offre, fixer des prix justes, rédiger devis et contrats et organiser son activité au quotidien.',
        pratique: 'Une offre, une grille de prix et un devis construits ensemble.',
        motsClesImage: 'freelancer home office planning',
      },
      {
        slug: 'freelance-clients',
        titre: 'Trouver des clients',
        accroche: 'Un carnet de commandes rempli, mois après mois.',
        description:
          'Prospecter, utiliser les plateformes freelance (Malt, Fiverr, Upwork) et obtenir des recommandations.',
        pratique: 'Des profils et des messages de prospection rédigés et testés.',
        motsClesImage: 'business handshake meeting',
      },
      {
        slug: 'freelance-agence',
        titre: 'Créer son agence : SMMA et services IA',
        accroche: 'Passez de freelance à chef d’agence.',
        description:
          'Monter une agence de gestion des réseaux sociaux (SMMA) ou de services IA, structurer ses offres et déléguer.',
        pratique: 'Une offre d’agence construite, du pitch à la livraison.',
        motsClesImage: 'small agency team office',
      },
    ],
  },
  {
    slug: 'compta',
    titre: 'Comptabilité & Gestion financière',
    emoji: '🧮',
    pole: 'business',
    ordre: 13,
    accroche: 'Comprenez vos chiffres pour mieux décider.',
    description:
      'Lire un bilan, suivre sa trésorerie, facturer correctement et piloter les finances de son activité.',
    motsClesImage: 'accounting calculator finance documents',
    formations: [
      {
        slug: 'compta-comprendre',
        titre: 'Comprendre ses chiffres',
        accroche: 'Bilan, compte de résultat, trésorerie : enfin clairs.',
        description:
          'Les bases de la comptabilité, la lecture des documents financiers et le suivi de la trésorerie et du fonds de roulement.',
        pratique: 'Des documents financiers réels lus et analysés ligne par ligne.',
        motsClesImage: 'financial statements analysis',
      },
      {
        slug: 'compta-gerer',
        titre: 'Gérer les finances de son activité',
        accroche: 'Des finances saines, sans stress.',
        description:
          'Facturation et devis, fiscalité de base, séparation des finances personnelles et professionnelles, tableaux de bord sur Excel.',
        pratique: 'Un tableau de bord financier construit sur Excel, pas à pas.',
        motsClesImage: 'small business budget spreadsheet',
        logiciel: true,
      },
    ],
  },
  {
    slug: 'projet',
    titre: 'Gestion de projet & Management',
    emoji: '🗂️',
    pole: 'business',
    ordre: 14,
    accroche: 'Menez vos projets jusqu’au bout, dans les délais.',
    description:
      'Planifier, organiser, suivre et piloter une équipe, avec les méthodes et outils des chefs de projet.',
    motsClesImage: 'project management team planning board',
    formations: [
      {
        slug: 'projet-mener',
        titre: 'Mener un projet de A à Z',
        accroche: 'Une méthode claire pour ne plus rien laisser au hasard.',
        description:
          'Cadrer un projet, le planifier avec un diagramme de Gantt, suivre l’avancement et gérer les risques et les délais.',
        pratique: 'Un projet planifié et suivi du lancement à la clôture.',
        motsClesImage: 'gantt chart planning',
      },
      {
        slug: 'projet-agile-equipes',
        titre: 'Agilité, outils et équipes à distance',
        accroche: 'Travailler vite et bien, même à distance.',
        description:
          'Les méthodes agiles et Scrum, les outils Trello, Notion et Asana, et l’animation d’une équipe à distance.',
        pratique: 'Un espace de travail d’équipe configuré et utilisé en situation.',
        motsClesImage: 'remote team video meeting',
        logiciel: true,
      },
    ],
  },

  // ── Pôle 4 : Tech & Données ───────────────────────────────────────────
  {
    slug: 'dev-web',
    titre: 'Développement web & mobile',
    emoji: '💻',
    pole: 'tech',
    ordre: 15,
    accroche: 'Créez des sites et des applications, avec ou sans code.',
    description:
      'De WordPress au code, jusqu’au développement assisté par IA : les compétences pour construire le web.',
    motsClesImage: 'web developer code screen',
    formations: [
      {
        slug: 'devweb-sans-code',
        titre: 'Créer un site avec WordPress et sans code',
        accroche: 'Un site professionnel, sans écrire une ligne de code.',
        description:
          'Choisir son outil, construire un site avec WordPress ou un créateur visuel, et le mettre en ligne.',
        pratique: 'Un site complet construit et mis en ligne pas à pas.',
        motsClesImage: 'website builder laptop design',
        logiciel: true,
      },
      {
        slug: 'devweb-html-css-js',
        titre: 'HTML, CSS et JavaScript',
        accroche: 'Les trois langages de base du web.',
        description:
          'Structurer une page, la mettre en forme et la rendre interactive : les fondations de tout développeur web.',
        pratique: 'Des pages codées en direct, ligne par ligne.',
        motsClesImage: 'html css code editor',
        logiciel: true,
      },
      {
        slug: 'devweb-avance-ia',
        titre: "React, back-end et développement avec l'IA",
        accroche: 'Passez au niveau des applications modernes.',
        description:
          'Les applications React, les bases de données et le back-end, et comment l’IA accélère le développement.',
        pratique: 'Une application construite de bout en bout avec l’aide de l’IA.',
        motsClesImage: 'software developer programming',
        logiciel: true,
      },
    ],
  },
  {
    slug: 'no-code',
    titre: 'Automatisation & No-code',
    emoji: '⚙️',
    pole: 'tech',
    ordre: 16,
    accroche: 'Laissez les machines faire les tâches répétitives.',
    description:
      'Créer des outils, des bases de données et des automatisations sans programmer, jusqu’aux agents IA.',
    motsClesImage: 'automation workflow diagram',
    formations: [
      {
        slug: 'nocode-outils',
        titre: 'Notion, Airtable et applications sans code',
        accroche: 'Vos propres outils de travail, sans développeur.',
        description:
          'Organiser son activité avec Notion et Airtable et créer des applications simples sans code.',
        pratique: 'Un espace de travail et une application construits pas à pas.',
        motsClesImage: 'organized workspace productivity app',
        logiciel: true,
      },
      {
        slug: 'nocode-automatiser',
        titre: 'Automatiser avec Make, Zapier, n8n et les agents IA',
        accroche: 'Des heures gagnées, chaque semaine.',
        description:
          'Connecter ses outils entre eux, automatiser les tâches répétitives et créer des agents IA qui travaillent pour vous.',
        pratique: 'Des automatisations réelles construites et testées en direct.',
        motsClesImage: 'robot automation technology',
        logiciel: true,
      },
    ],
  },
  {
    slug: 'data',
    titre: 'Analyse de données & Data',
    emoji: '📊',
    pole: 'tech',
    ordre: 17,
    accroche: 'Transformez des chiffres en décisions.',
    description:
      'Analyser des données avec Excel et Google Sheets, construire des tableaux de bord et aller plus loin avec Python et SQL.',
    motsClesImage: 'data analytics dashboard charts',
    formations: [
      {
        slug: 'data-excel-sheets',
        titre: 'Analyser avec Excel et Google Sheets',
        accroche: 'Les tableurs, votre premier outil d’analyse.',
        description:
          'Nettoyer des données, utiliser les formules clés et les tableaux croisés dynamiques pour en tirer des conclusions.',
        pratique: 'Des analyses réalisées en direct sur de vrais jeux de données.',
        motsClesImage: 'spreadsheet data analysis',
        logiciel: true,
      },
      {
        slug: 'data-dashboards',
        titre: 'Tableaux de bord et Power BI',
        accroche: 'Vos chiffres clés, en un coup d’œil.',
        description:
          'Choisir les bons indicateurs et construire des tableaux de bord clairs avec Looker Studio et Power BI.',
        pratique: 'Un tableau de bord complet construit pas à pas.',
        motsClesImage: 'business intelligence dashboard',
        logiciel: true,
      },
      {
        slug: 'data-python-sql',
        titre: 'Python et SQL pour la data',
        accroche: 'Les outils des analystes professionnels.',
        description:
          'Interroger une base de données avec SQL et analyser des données avec Python.',
        pratique: 'Des requêtes et des analyses codées en direct.',
        motsClesImage: 'python programming data',
        logiciel: true,
      },
    ],
  },
  {
    slug: 'cyber',
    titre: 'Cybersécurité & Protection des données',
    emoji: '🔒',
    pole: 'tech',
    ordre: 18,
    accroche: 'Protégez vos comptes, vos clients et votre argent.',
    description:
      'Les bons réflexes de sécurité au quotidien et la protection d’une activité en ligne.',
    motsClesImage: 'cybersecurity lock laptop',
    formations: [
      {
        slug: 'cyber-quotidien',
        titre: 'Se protéger au quotidien',
        accroche: 'Les réflexes qui évitent 90 % des problèmes.',
        description:
          'Mots de passe solides, double authentification, reconnaître le phishing et les arnaques en ligne.',
        pratique: 'Des comptes sécurisés et des arnaques décortiquées exemple par exemple.',
        motsClesImage: 'password security smartphone',
      },
      {
        slug: 'cyber-activite',
        titre: 'Protéger son activité : site, données et paiements',
        accroche: 'La confiance de vos clients commence par leur sécurité.',
        description:
          'Sécuriser son site, protéger les données clients, respecter les règles de confidentialité et sécuriser les paiements et le Mobile Money.',
        pratique: 'Une vérification de sécurité menée sur un vrai site, point par point.',
        motsClesImage: 'data protection server',
      },
    ],
  },
  {
    slug: 'bureautique',
    titre: 'Informatique & Bureautique',
    emoji: '🖥️',
    pole: 'tech',
    ordre: 19,
    accroche: 'Soyez à l’aise et rapide sur ordinateur.',
    description:
      'Maîtriser l’ordinateur et les logiciels de bureau : Word, Excel, PowerPoint, Google Workspace et les assistants IA.',
    motsClesImage: 'office computer desk work',
    formations: [
      {
        slug: 'bureautique-word-powerpoint',
        titre: 'Word et PowerPoint',
        accroche: 'Des documents et des présentations impeccables.',
        description:
          'Mettre en forme des documents professionnels et créer des présentations claires et convaincantes.',
        pratique: 'Un document et une présentation réalisés de A à Z.',
        motsClesImage: 'presentation slides office',
        logiciel: true,
      },
      {
        slug: 'bureautique-excel',
        titre: 'Excel, de débutant à avancé',
        accroche: 'L’outil le plus demandé en entreprise.',
        description:
          'Des premières formules aux tableaux croisés dynamiques, en passant par les graphiques et l’automatisation.',
        pratique: 'Des classeurs construits en direct, du plus simple au plus avancé.',
        motsClesImage: 'excel spreadsheet laptop',
        logiciel: true,
      },
      {
        slug: 'bureautique-google-ia',
        titre: 'Informatique, Google Workspace et IA',
        accroche: 'Travailler efficacement, partout et en équipe.',
        description:
          'Organiser son ordinateur et ses fichiers, travailler avec Gmail, Drive et Docs, gérer ses emails, et utiliser l’IA dans les outils de bureau.',
        pratique: 'Un environnement de travail organisé et configuré ensemble.',
        motsClesImage: 'cloud collaboration office',
        logiciel: true,
      },
    ],
  },

  // ── Pôle 5 : Compétences humaines ─────────────────────────────────────
  {
    slug: 'prise-parole',
    titre: 'Prise de parole & Communication',
    emoji: '🎤',
    pole: 'humain',
    ordre: 20,
    accroche: 'Convainquez à l’oral, en face ou en vidéo.',
    description:
      'Parler en public sans stress, pitcher un projet et être à l’aise face caméra et en réunion.',
    motsClesImage: 'public speaking conference',
    formations: [
      {
        slug: 'parole-public',
        titre: 'Parler en public avec aisance',
        accroche: 'Le trac en moins, l’impact en plus.',
        description:
          'Gérer le stress, structurer son discours et utiliser sa voix, sa posture et ses gestes pour captiver.',
        pratique: 'Des prises de parole analysées et améliorées, exemple après exemple.',
        motsClesImage: 'speaker stage audience',
      },
      {
        slug: 'parole-pitch-camera',
        titre: 'Pitch, caméra et webinaires',
        accroche: 'Présentez votre projet comme un pro.',
        description:
          'Construire un pitch percutant, être naturel face caméra et animer réunions et webinaires.',
        pratique: 'Un pitch et une intervention face caméra préparés pas à pas.',
        motsClesImage: 'webinar presenter camera',
      },
    ],
  },
  {
    slug: 'langues',
    titre: 'Langues',
    emoji: '🌍',
    pole: 'humain',
    ordre: 21,
    accroche: 'Ouvrez-vous à de nouveaux clients et marchés.',
    description:
      'Anglais, espagnol, français professionnel et chinois, orientés travail et business.',
    motsClesImage: 'language learning books world',
    formations: [
      {
        slug: 'langues-anglais',
        titre: 'Anglais : des bases au business',
        accroche: 'La langue des affaires internationales.',
        description:
          "De l'anglais du quotidien à l'anglais professionnel : échanges, emails, réunions et négociation.",
        pratique: 'Des situations réelles jouées et commentées.',
        motsClesImage: 'english conversation business',
      },
      {
        slug: 'langues-espagnol',
        titre: 'Espagnol : débutant et intermédiaire',
        accroche: 'Plus de 500 millions de locuteurs à portée de voix.',
        description: "Les bases de l'espagnol, puis les échanges du quotidien et du travail.",
        pratique: 'Des dialogues réels, décortiqués et répétés.',
        motsClesImage: 'spanish language learning',
      },
      {
        slug: 'langues-francais-pro',
        titre: 'Français professionnel',
        accroche: 'Écrire et parler avec aisance au travail.',
        description:
          'Emails, courriers, comptes rendus et prise de parole : un français clair et professionnel.',
        pratique: 'Des écrits professionnels rédigés et corrigés ensemble.',
        motsClesImage: 'writing professional letter',
      },
      {
        slug: 'langues-chinois',
        titre: 'Chinois : premiers pas',
        accroche: 'Une langue clé pour le commerce international.',
        description: 'Les sons, les caractères de base et les phrases utiles pour échanger avec des partenaires.',
        pratique: 'Des échanges simples, prononcés et répétés pas à pas.',
        motsClesImage: 'chinese calligraphy learning',
      },
    ],
  },
  {
    slug: 'dev-perso',
    titre: 'Développement personnel',
    emoji: '🌱',
    pole: 'humain',
    ordre: 22,
    accroche: 'L’état d’esprit qui fait tenir dans la durée.',
    description:
      'Organisation, objectifs, confiance et gestion des émotions pour avancer sereinement dans ses projets.',
    motsClesImage: 'personal growth sunrise mountain',
    formations: [
      {
        slug: 'devperso-organisation',
        titre: 'Organisation, objectifs et mindset',
        accroche: 'Faire ce qui compte, chaque jour.',
        description:
          'Gérer son temps, fixer des objectifs atteignables, créer de bonnes habitudes et adopter l’état d’esprit d’un entrepreneur.',
        pratique: 'Un plan d’organisation personnelle construit ensemble.',
        motsClesImage: 'planner goals journal',
      },
      {
        slug: 'devperso-confiance',
        titre: 'Confiance, émotions et stress',
        accroche: 'Plus serein, plus sûr de vous.',
        description:
          'Développer sa confiance en soi, comprendre ses émotions et mieux gérer le stress au travail.',
        pratique: 'Des exercices guidés à appliquer au quotidien.',
        motsClesImage: 'calm confident person',
      },
    ],
  },
];

export const ACADEMY_MODULE_SLUGS = ACADEMY_MODULES.map((m) => m.slug) as [string, ...string[]];

export function trouverModule(slug?: string | null): AcademyModule | undefined {
  if (!slug) return undefined;
  return ACADEMY_MODULES.find((m) => m.slug === slug);
}

export function trouverFormationDef(
  slug?: string | null
): { module: AcademyModule; formation: AcademyFormationDef } | undefined {
  if (!slug) return undefined;
  for (const module of ACADEMY_MODULES) {
    const formation = module.formations.find((f) => f.slug === slug);
    if (formation) return { module, formation };
  }
  return undefined;
}

/** Programme officiel, affiché tel quel : « 22 domaines · 60 formations au programme ». */
export const TOTAL_DOMAINES = ACADEMY_MODULES.length;
export const TOTAL_FORMATIONS_PREVUES = ACADEMY_MODULES.reduce((n, m) => n + m.formations.length, 0);

// ─── Textes de vente (validés le 25/09/2026) ─────────────────────────────
// Base commune ; l'IA les adapte à chaque formation dans les voix off.

export const TEXTES_VENTE = {
  /** Sous-titre de l'accueil Académie. */
  domaine:
    'Découvrez les bases de votre domaine, puis passez à la vraie formation : le cours détaillé, la phase pratique pour appliquer, et le Kit Expert pour tout maîtriser.',
  /** Phrase d'accroche, reprise sous le titre de l'Académie. */
  accroche: 'Formez-vous aujourd’hui, lancez votre activité en ligne dès demain.',
  partieBases:
    'Les bases générales du domaine, expliquées simplement en quelques minutes par votre formateur IA NexAI. Le point de départ idéal avant la formation complète.',
  partieComplete:
    'C’est ici que la vraie formation commence : le cours détaillé, puis la phase pratique pour passer à l’action, et le Kit Expert pour maîtriser pleinement le sujet.',
  comprendre: 'Le cours complet en vidéo animée, expliqué pas à pas par votre formateur IA NexAI.',
  /** Phase pratique : texte commun, vrai quelle que soit la source des vidéos. */
  phasePratique:
    'Formation pratique guidée pour appliquer ce que vous venez d’apprendre. C’est là que la théorie devient un vrai savoir-faire.',
  /** Badges « Phase pratique » : indiquent honnêtement QUI guide la pratique. */
  pratiqueReelle: 'Phase pratique avec formateur réel',
  pratiqueIa: 'Phase pratique guidée par votre formateur IA NexAI',
  pratiqueMixte: 'Phase pratique : formateur IA NexAI + formateur réel',
  kit: '+ Kit Expert offert',
  kitDetail:
    'Votre Kit Expert : guides, modèles prêts à l’emploi, check-lists et fiches de référence, tout ce qu’il faut pour maîtriser pleinement cette formation. À télécharger et garder, personnalisé à votre nom.',
  deblocage:
    'La vraie formation commence ici : la phase pratique pour appliquer, et le Kit Expert pour tout maîtriser. Toute l’Académie débloquée pour 5 000 FCFA par mois.',
  finEssai: 'Votre essai est terminé, mais votre progression vous attend. Reprenez exactement où vous en étiez avec Starter.',
  /** Bandeau d'accueil : passer d'abord par le Coach business si pas d'idée précise. */
  coachTitre: 'Pas encore d’idée précise de business ?',
  coachTexte:
    'Commencez par le Coach business NexAI : en quelques questions, il vous aide à trouver une idée qui a du potentiel en 2026 et qui vous correspond. Revenez ensuite choisir le domaine qui va avec, formez-vous et lancez votre activité en ligne sans attendre.',
  coachAction: 'Trouver mon idée avec le Coach business',
} as const;
