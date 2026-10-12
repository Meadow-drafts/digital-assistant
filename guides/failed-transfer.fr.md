---
id: failed-transfer
audience: individual, merchant
route: any payment or transfer result
package: none
verified-on: DRAFT 2026-10-12, code read only, owner to validate
---
# Ma transaction a échoué : que signifie le message et que faire

## Quand l'utiliser
Un transfert ou un paiement s'est terminé par un message d'erreur ou **Paiement échoué**.

## Signification des messages
| Message | Signification | Que faire |
|---|---|---|
| Solde insuffisant / Fonds insuffisants | Le montant (plus les frais) dépasse votre solde disponible | Vérifiez votre solde, réduisez le montant |
| Mauvais code PIN / Mauvais code OTP | Le PIN ou l'OTP saisi est incorrect | Ressaisissez avec soin. Ne les communiquez à personne, y compris dans ce chat |
| Limite de montant dépassée ; « inférieur au seuil minimum » / « dépasse le plafond maximum » | Le montant est hors de la plage autorisée ; le message indique le montant et la limite | Modifiez le montant |
| Plafond cumulé atteint (jour, semaine, mois, trimestre, semestre, année) | Vous avez atteint le plafond cumulé de montants pour cette période | Attendez la période suivante ou contactez votre agence |
| Nombre maximum de transactions atteint (jour à année) | Vous avez atteint le nombre d'opérations autorisées pour cette période | Attendez la période suivante ou contactez votre agence |
| Nombre maximal de transactions dépassé | Limite de montant ou de nombre atteinte (le portail utilise un seul message pour les deux) | Contactez votre agence pour savoir laquelle |
| Wallet introuvable / Le wallet/compte destinataire est introuvable | Le destinataire n'existe pas ou n'est pas valide | Vérifiez le numéro avec le destinataire |
| Vous ne pouvez pas transférer vers vous-même | Le wallet expéditeur est identique au wallet destinataire | Choisissez un autre destinataire |
| Compte introuvable / Impossible d'obtenir le compte créditeur | Un compte n'est pas configuré ou le rattachement est incomplet | Contactez votre agence |
| Client bloqué / OPPOSITION | Votre compte est bloqué ou sous opposition | Contactez votre agence |
| Compte déjà rattaché ou en attente de validation au siège | Le rattachement du compte n'est pas terminé | Attendez la validation, ou contactez votre agence |
| Service Gimac indisponible | Le réseau GIMAC est indisponible pour le moment | Réessayez plus tard ; ne répétez pas en boucle |
| Application en maintenance / Transactions bloquées, réessayez plus tard | Le service est temporairement indisponible | Réessayez plus tard |
| Montant invalide / Le montant de l'opération est de zéro | Le montant est incorrect | Saisissez un montant valide |
| Le reversement est actuellement désactivé | Les reversements sont désactivés à la banque | Contactez votre agence |
| Échec de l'opération / Une exception s'est produite | Problème technique | Vérifiez dans **Historique** si vous avez été débité, puis contactez un agent |

## Important
- Si le statut est **Paiement en attente**, ne réessayez pas. Vérifiez d'abord dans **Historique**.
- Si vous avez été débité mais la transaction a échoué, parlez à un agent avec la référence de la transaction.

## Parlez à un agent si
Vous avez été débité et la transaction a échoué, le message ne figure pas dans cette liste, ou vous avez besoin d'une annulation.
