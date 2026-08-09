# Protocolo de presencia multijugador (bloque 3)

## Autoridad y orden

- El servidor asigna `seq` monotónico por usuario para `presence:spawn`,
  `presence:move`, `presence:skin` y `presence:leave`.
- Flutter ignora una presencia con `seq` menor o igual a la aplicada. La única
  excepción es un snapshot con la misma secuencia cuando la representación fue
  vaciada al perder el socket local.
- `lifeSeq` versiona la vida de forma independiente. Una vida antigua no puede
  sobrescribir una nueva, ni siquiera durante el procesamiento del snapshot.
- `serverTimestamp` es hora del servidor. La hora del móvil no decide el orden.
- `lastSeen` se actualiza con movimiento y heartbeat.
- `snapshotVersion` versiona cambios de presencia en la instancia actual.
- `presenceSessionId` identifica la sesión primaria que produjo el estado.

## Reconexión y expiración

- Flutter envía `presence:heartbeat` cada **10 segundos** mientras el socket
  está conectado.
- Un `disconnect` explícito del cliente programa la baja inmediatamente.
- Un corte anómalo conserva la presencia durante **15 segundos**. Si el usuario
  no vuelve, el servidor emite un `presence:leave` versionado con motivo
  `disconnect-timeout`.
- Una reconexión dentro de la gracia cancela la baja, incrementa `seq` y recibe
  un snapshot completo de jugadores.

Socket.IO mantiene además su ping/pong de transporte. El heartbeat de Able73 no
lo sustituye; aporta `lastSeen` de aplicación y una ruta de diagnóstico.

## Dos dispositivos con la misma cuenta

El último `presence:hello` válido es el **socket primario de presencia**. Los
otros sockets siguen conectados y reciben eventos, pero sus `presence:update`
se ignoran. Si el primario se desconecta, el socket secundario más reciente se
promociona. Así existe una sola posición lógica sin expulsar agresivamente el
otro dispositivo.

## Snapshot

El ACK de `presence:hello` incluye `players`, `snapshotVersion`,
`serverTimestamp` e `instanceId`. Cada jugador contiene posición, heading,
nickname, skin, vida, `seq`, `lifeSeq`, `lastSeen` y `presenceSessionId`.

## Alcance deliberadamente pendiente

Las secuencias y la presencia siguen en memoria de una sola instancia. El room
actual continúa siendo `GLOBAL_TEST_ROOM`. Una futura partición por `zoneId` y
coordinación multiinstancia deberá persistir/compartir estas versiones; no se
ha iniciado esa migración en el bloque 3.
