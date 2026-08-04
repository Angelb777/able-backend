# Sistema social, clanes y PVP

## Arquitectura

- `User.nickname` es la única identidad visible social y `normalizedNickname` se usa para búsqueda y unicidad sin distinguir mayúsculas/minúsculas. `User.nombre` permanece privado.
- Un usuario sin nickname recibe únicamente un alias técnico no persistido (`Jugador-` + últimos cinco caracteres del `_id`) y no puede entrar en PVP ni usar acciones sociales hasta completar el onboarding.
- `Clan` conserva miembros, invitaciones y solicitudes como subdocumentos. Un usuario se consulta por `members.userId`, por lo que puede pertenecer a cualquier número de clanes.
- `clanMembershipCache` mantiene conjuntos de IDs de clan por usuario durante 60 segundos. Las rutas de clan invalidan los usuarios afectados y el socket actualiza la presencia inmediatamente.
- `Notification` persiste avisos con `dedupeKey` único. `socialRealtime` entrega además eventos a sockets conectados sin crear otro sistema de presencia.
- `Taunt` contiene catálogo y precio del servidor. `Bounty` representa Stepcoins en depósito hasta cobro o expiración.
- `CombatKillEvent.killEventId` y `StepcoinTransaction.operationKey` son claves únicas de idempotencia.

## Migración de nicknames

El índice `normalizedNickname_unique_partial` solo incluye documentos que ya tienen un string normalizado. Por ello puede desplegarse aunque existan usuarios heredados sin nickname.

1. Ejecutar `npm run nicknames:audit` y revisar el plan; no modifica datos ni imprime nombres privados.
2. Hacer copia de seguridad.
3. Resolver manualmente los conflictos reportados. La herramienta nunca inventa ni sustituye nicknames.
4. Ejecutar `npm run nicknames:migrate`: solo completa `normalizedNickname` cuando ya existe un nickname válido y deja el resto pendiente de onboarding.

No se debe reemplazar el índice parcial por uno completo hasta que el dry-run indique cero usuarios pendientes.

## REST

Todas estas rutas exigen `Authorization: Bearer <JWT>`:

- `POST /api/clans`, `PUT|DELETE /api/clans/:clanId`
- `GET /api/clans/overview`, `GET /api/clans/:clanId`
- `GET /api/clans/created/invitable?targetUserId=...`
- `POST /api/clans/:clanId/invitations`
- `POST /api/clans/:clanId/invitations/:invitationId/{accept|reject|cancel}`
- `POST /api/clans/:clanId/join-requests`
- `POST /api/clans/:clanId/join-requests/:requestId/{accept|reject|cancel}`
- `POST /api/clans/:clanId/leave`
- `DELETE /api/clans/:clanId/members/:userId`
- `GET /api/social/me`, `PUT /api/social/me/nickname`
- `GET /api/social/users/search?nickname=...`
- `GET /api/social/taunts`, `POST /api/social/taunts/send`
- `POST /api/social/bounties`, `GET /api/social/bounties/totals`
- `GET /api/social/notifications`, `POST /api/social/notifications/:id/read`
- `POST /api/social/bounties/process-expired` (solo admin)

Creación de burla y recompensa admite `requestKey` o cabecera `Idempotency-Key`.

## Socket `/pvp`

El JWT se envía en `handshake.auth.token`. El servidor obtiene el nickname desde MongoDB, ignora cualquier nickname enviado por el cliente, rechaza un `presence:hello.userId` distinto del token y bloquea presencia con `NICKNAME_REQUIRED` si falta el nickname.

Eventos añadidos:

- servidor → cliente: `presence:social`, `presence:identity`, `clan:membership-changed`
- servidor → cliente: `life:protected`, `combat:death`
- servidor → cliente: `taunt:received`, `bounty:total`
- servidor → cliente: `notification:new`, `stepcoins:update`

La presencia inicial y los eventos `presence:spawn/move` incluyen `nickname`, `clanIds` y `bountyTotal`, evitando consultas por jugador y por frame. Nunca incluyen `nombre`.

## Contratos públicos de identidad

- `GET /api/social/me`: `id`, `nickname`, `hasChosenNickname`, `needsNickname`, `avatarUrl`, `stepcoins`.
- `GET /api/social/users/search`: `id`, `nickname`, `avatarUrl`, `isSelf`.
- Usuario dentro de clanes: `id`, `nickname`, `hasChosenNickname`, `avatarUrl`.
- Presencia: `userId`, coordenadas, dirección, skin, `nickname`, vida, clanes y recompensa.
- `/api/users/:id` exige JWT y ser el propio usuario o admin; su respuesta está limitada y no contiene nombre, email ni perfil.

## Protección PVP

El punto central es `applyPlayerDamage` en `sockets/pvp.socket.js`. Bala, torreta, mina y ataque aéreo pasan por este helper antes de persistir vida. Si atacante y objetivo comparten un clan activo, emite `life:protected`, conserva la animación de impacto y no actualiza vida, muerte, estadísticas ni recompensas.

## Stepcoins e idempotencia

- Burla: transacción MongoDB con decremento condicionado por saldo y ledger `taunt:<sender>:<requestKey>`. El precio se lee de `Taunt`.
- Recompensa: transacción que descuenta saldo, crea `Bounty` y registra `bounty-create:<creator>:<requestKey>`.
- Cobro: la transición a muerte crea un `CombatKillEvent` único, reclama solo recompensas `active` elegibles y abona al atacante en la misma transacción.
- Expiración: un worker por proceso busca recompensas vencidas cada minuto. La transición condicionada `active → expired`, devolución y ledger `bounty-refund:<id>` ocurren en transacción; se puede ejecutar manualmente desde la ruta admin.

Variables opcionales: `BOUNTY_DURATION_MS`, `BOUNTY_EXPIRY_INTERVAL_MS`, `TAUNT_COOLDOWN_MS`, `MIN_BOUNTY_STEPCOINS`, `MAX_BOUNTY_STEPCOINS`.
