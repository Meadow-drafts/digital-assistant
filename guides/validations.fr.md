---
id: validations
audience: individual with a validation profile (principal wallet sees all tabs)
route: /validations
package: none
verified-on: DRAFT 2026-10-12, code read only, owner to validate
---
# Approuver, refuser ou consulter une validation

## Quand l'utiliser
Le back-office de la banque configure, pour chaque utilisateur, les actions qui nécessitent une validation. Utilisez ce guide lorsque vous devez valider une action qui vous concerne, ou pour consulter la validation d'une telle action.

## Étapes
1. Ouvrez **Validations**. Onglets : **Toutes les validations** (wallet principal uniquement), **Mes validations**, **Mes validations en attente**.
2. Dans **Mes validations en attente**, chaque ligne affiche le service, la description, le wallet, le créateur, le niveau (par exemple 1/2), le statut et la date.
3. Utilisez l'icône œil (« see detail ») ou l'icône transaction (« see transaction ») pour vérifier ce que vous approuvez.
4. Approuvez ou refusez : une fenêtre demande « Are you sure you want to approve the validation? » avec **Approve** et **Deny**. Pour un paiement groupé, ouvrez sa page de détail et utilisez le bouton **Approve** ou **Deny**.
5. Le résultat indique « Validation has been approved » ou « denied ». Quand le dernier niveau approuve, l'opération est exécutée.

## Erreurs fréquentes
- « Cannot Approve validation ! » : le statut doit être PENDING pour un validateur, ou CONTROLLER pour un contrôleur. Vous ne pouvez agir qu'à votre niveau.
- La demande n'est pas dans votre liste : elle attend à un autre niveau ou une autre personne.

## Parlez à un agent si
Une validation reste bloquée à un niveau, vous avez approuvé par erreur, ou vous n'avez pas le profil validateur ou contrôleur nécessaire.
