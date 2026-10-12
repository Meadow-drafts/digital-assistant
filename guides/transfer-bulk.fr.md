---
id: transfer-bulk
audience: individual
route: /transfer (Bulk Transfer tab)
package: TRINC, TRINW, TRIB (any one)
verified-on: DRAFT 2026-10-12, code read only, owner to validate
---
# Effectuer un transfert groupé depuis un fichier Excel

## Quand l'utiliser
Vous voulez payer plusieurs destinataires en une fois depuis un compte.

## Étapes
1. Ouvrez **Transfert**, onglet **Transfert groupé**.
2. Cliquez sur **Télécharger un exemple** et remplissez le fichier Excel. Colonnes : MEMBRE (MEMBER), CODE MEMBRE (MEMBERCODE), TYPE, COMPTE (ACCOUNT), MONTANT (AMOUNT), RÉFÉRENCE (REFERENCE). La deuxième feuille de l'exemple liste les opérateurs, banques et codes valides.
3. Téléversez votre fichier **.xlsx** en le glissant ou en cliquant pour téléverser (taille maximale : 10 Mo). Les lignes s'affichent pour vérification. **Téléverser un nouveau fichier** permet de le remplacer.
4. Choisissez le compte à débiter et saisissez le **Motif**.
5. Cliquez sur **Procéder**. La fenêtre « Détails de la transaction » affiche les frais, la TVA et le total. Saisissez votre code PIN (et le code OTP si votre profil l'exige).
6. Vous arrivez sur la page de statut des transferts, avec une ligne par transfert et son statut. Vous la retrouvez ensuite dans **Historique**.

## Erreurs fréquentes
- Fichier refusé : uniquement .xlsx, moins de 10 Mo, avec les colonnes de l'exemple.
- « Manque de profil initiateur pour initier la transaction » : votre profil ne peut pas lancer de transferts groupés ; contactez votre administrateur.
- Certaines lignes échouent : vérifiez la colonne statut ligne par ligne.
- Lignes en attente : ne renvoyez pas le fichier ; vérifiez d'abord le statut.

## Parlez à un agent si
Vous avez été débité pour des lignes marquées échouées, ou si tout le lot reste en attente.
