# Mise en ligne sur votre domaine OVH

Objectif : `https://agenda.mondomaine.fr`, connexion par compte Google, et des
proches qui rejoignent votre agenda familial via un lien d'invitation.

---

## 1. Vérifier quel hébergement OVH vous avez

C'est le point décisif : **FamilyBoard est une application Node.js qui doit tourner
en permanence**. Tous les hébergements OVH ne le permettent pas.

Connectez-vous à l'espace client OVH et regardez dans quelle rubrique apparaît
votre produit :

| Rubrique OVH | Ce que c'est | FamilyBoard |
| --- | --- | --- |
| **VPS** ou **Public Cloud** | Un serveur à vous, avec accès SSH | ✅ Convient |
| **Serveurs dédiés** | Idem, en plus puissant | ✅ Convient |
| **Hébergements** (Perso, Pro, Performance) | Hébergement web mutualisé : PHP et MySQL | ❌ Ne convient pas |

Test en ligne de commande, si vous avez reçu une adresse IP et un accès SSH :

```bash
ssh ubuntu@VOTRE_IP    # ou root@VOTRE_IP selon l'image installée
node --version         # une fois connecté
```

Si vous vous connectez en SSH et pouvez installer des paquets, vous êtes sur un
VPS : passez à l'étape 2.

**Si vous n'avez qu'un hébergement mutualisé**, il ne peut pas exécuter Node.js :
il sert des pages PHP et n'autorise aucun processus permanent. Deux options :

- garder l'hébergement mutualisé pour vos sites, et **ajouter un VPS OVH d'entrée
  de gamme** (1 vCPU / 2 Go de RAM suffisent très largement pour un agenda familial) ;
- utiliser tout autre serveur avec accès SSH — le domaine OVH, lui, fonctionnera
  très bien quel que soit l'hébergeur.

Dans les deux cas, **le nom de domaine reste chez OVH** : seule la zone DNS change.

---

## 2. Faire pointer le domaine vers le serveur

Espace client OVH → **Noms de domaine** → votre domaine → onglet **Zone DNS** →
*Ajouter une entrée* :

| Type | Sous-domaine | Cible |
| --- | --- | --- |
| `A` | `agenda` | l'adresse IPv4 de votre VPS |
| `AAAA` | `agenda` | l'adresse IPv6 du VPS (si vous en avez une) |

Comptez quelques minutes à quelques heures de propagation. Vérification :

```bash
dig +short agenda.mondomaine.fr
```

L'adresse IP de votre serveur doit s'afficher.

---

## 3. Créer les identifiants Google

Sans cette étape, personne ne peut se connecter à l'application.

1. [Google Cloud Console](https://console.cloud.google.com/) → créez un projet.
2. **API et services → Bibliothèque** → activez **Google Calendar API**.
3. **Écran de consentement OAuth** : type « Externe », nom de l'application
   (« Agenda familial »), votre adresse en contact. Tant que l'application est
   en mode test, ajoutez chaque membre de la famille dans **Utilisateurs de test**.
4. **Identifiants → Créer des identifiants → ID client OAuth → Application Web**.
5. **URI de redirection autorisés** — les deux, exactement :

   ```
   https://agenda.mondomaine.fr/api/auth/google/callback
   https://agenda.mondomaine.fr/api/oauth/google/callback
   ```

   Le premier sert à la connexion, le second à la synchronisation de l'agenda Google.
6. Notez l'ID client et le secret.

Pour Outlook professionnel, la marche à suivre côté Azure est décrite dans le
[README](README.md#outlook--microsoft-365-compte-professionnel) ; l'URI à déclarer
est `https://agenda.mondomaine.fr/api/oauth/outlook/callback`.

---

## 4. Installer — option A : Docker (le plus simple)

Sur le VPS, en root :

```bash
# Docker
curl -fsSL https://get.docker.com | sh

# L'application
git clone https://github.com/petertroubs/Familyboard.git /opt/familyboard
cd /opt/familyboard
cp .env.example .env
nano .env
```

Renseignez au minimum :

```dotenv
DOMAIN=agenda.mondomaine.fr
APP_BASE_URL=https://agenda.mondomaine.fr
DEFAULT_TIMEZONE=Europe/Paris
SIGNUP_MODE=invite
GOOGLE_CLIENT_ID=…
GOOGLE_CLIENT_SECRET=…
```

Puis :

```bash
docker compose up -d
docker compose logs -f app
```

Caddy demande seul le certificat TLS à Let's Encrypt : après quelques secondes,
`https://agenda.mondomaine.fr` répond en HTTPS. Les ports 80 et 443 doivent être
ouverts (ils le sont par défaut sur un VPS OVH ; si vous avez activé un pare-feu,
autorisez-les).

Mise à jour ultérieure :

```bash
cd /opt/familyboard && git pull && docker compose up -d --build
```

---

## 4 bis. Installer — option B : systemd + Caddy (sans Docker)

```bash
# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git sqlite3

# Utilisateur dédié et code
sudo useradd --system --home /opt/familyboard --shell /usr/sbin/nologin familyboard
sudo git clone https://github.com/petertroubs/Familyboard.git /opt/familyboard
cd /opt/familyboard
sudo npm ci && sudo npm run build && sudo npm prune --omit=dev
sudo mkdir -p /var/lib/familyboard
sudo chown -R familyboard:familyboard /opt/familyboard /var/lib/familyboard

# Configuration
sudo cp .env.example /etc/familyboard.env
sudo nano /etc/familyboard.env     # DATABASE_PATH=/var/lib/familyboard/familyboard.db
sudo chmod 600 /etc/familyboard.env

# Service
sudo cp deploy/familyboard.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now familyboard
sudo systemctl status familyboard
```

Puis le proxy HTTPS, avec Caddy :

```bash
sudo apt-get install -y caddy
sudo tee /etc/caddy/Caddyfile >/dev/null <<'CADDY'
agenda.mondomaine.fr {
	encode zstd gzip
	reverse_proxy 127.0.0.1:3000
}
CADDY
sudo systemctl reload caddy
```

Ou avec nginx + certbot, en partant de `deploy/nginx.conf`.

---

## 5. Premier démarrage et invitation de la famille

1. Ouvrez `https://agenda.mondomaine.fr` et cliquez sur **Se connecter avec Google**.
   En mode `invite`, la toute première connexion **crée le foyer** et vous en fait
   le responsable.
2. Dans le panneau **Ma famille**, copiez le lien d'invitation
   (`https://agenda.mondomaine.fr/rejoindre/CODE`) et envoyez-le à vos proches.
3. Chacun se connecte avec son propre compte Google et rejoint automatiquement le
   même agenda. Les données d'un foyer ne sont jamais visibles par un autre.
4. Le responsable peut à tout moment régénérer le lien (les anciens cessent alors
   de fonctionner), promouvoir un autre responsable ou retirer un compte.
5. Chaque personne relie ensuite ses propres agendas Google perso et Outlook pro
   depuis le panneau **Agendas synchronisés**.

---

## 6. Sauvegardes

Toutes les données tiennent dans un seul fichier SQLite.

```bash
# Installation systemd
sudo crontab -e
0 3 * * * /opt/familyboard/deploy/backup.sh >> /var/log/familyboard-backup.log 2>&1

# Installation Docker
0 3 * * * docker compose -f /opt/familyboard/docker-compose.yml exec -T app \
  node -e "require('better-sqlite3')(process.env.DATABASE_PATH).backup('/data/backup.db')"
```

Copiez régulièrement ces sauvegardes hors du serveur (OVH Object Storage, autre
machine, etc.). Pensez aussi à `/etc/familyboard.env`, qui contient vos secrets OAuth.

---

## 7. Points de sécurité

L'application est faite pour être exposée sur Internet :

- session par cookie `HttpOnly` + `SameSite=Lax`, marqué `Secure` dès que
  `APP_BASE_URL` est en `https` ; seul le **hachage** du jeton est stocké en base ;
- inscriptions fermées par défaut (`SIGNUP_MODE=invite`) ;
- vérification d'origine sur toutes les écritures, limitation du nombre de
  tentatives de connexion, en-têtes `Content-Security-Policy`, `X-Frame-Options`,
  `Referrer-Policy` et HSTS ;
- les jetons Google et Outlook restent côté serveur et ne sont jamais renvoyés
  par l'API ;
- chaque requête est filtrée par foyer : un compte ne peut pas lire les données
  d'une autre famille.

Reste à votre charge : garder le système à jour (`apt upgrade`), sauvegarder, et
ne pas publier votre fichier `.env`.

---

## En cas de problème

| Symptôme | Cause la plus fréquente |
| --- | --- |
| `redirect_uri_mismatch` à la connexion | L'URI déclarée chez Google ne correspond pas exactement à `APP_BASE_URL` (http/https, sous-domaine, barre finale) |
| Connexion en boucle, session perdue | `APP_BASE_URL` en `https` mais le proxy ne transmet pas `X-Forwarded-Proto`, ou `TRUST_PROXY=0` |
| « Accès refusé » pour un proche | Mode `invite` et lien d'invitation périmé : régénérez-le et renvoyez-le |
| Certificat TLS non délivré | DNS pas encore propagé, ou ports 80/443 fermés |
| `AADSTS65001` côté Outlook | L'administrateur Microsoft 365 doit approuver l'application |
| Aucun rappel envoyé | `SMTP_HOST` non renseigné : les rappels restent dans le fil in-app |

Journaux : `docker compose logs -f app`, ou `journalctl -u familyboard -f`.
