# Policía y persecuciones

## Autoridad y aislamiento

`/pvp` sigue siendo la única autoridad competitiva. El runtime policial está
aislado del runtime OVNI: solo comparte presencia, el tick de balas del jugador
y `applyPlayerDamage`. No modifica temporizadores, modelos ni eventos `ufo:*`.

El sistema nace desactivado. Un Superadmin debe guardar recursos y activar
`Policía / Persecuciones` en Gestión de juego.

## Incidentes compartidos

El primer disparo programa una activación según el retraso de una estrella. Al
vencer, el servidor busca el incidente activo más cercano por distancia
geográfica. Si está dentro de `reuseRadiusMeters`, incorpora al usuario y
reutiliza sus NPCs; si no, crea un incidente. No hay división manual por
ciudades. Los límites globales y por incidente impiden crecimiento sin cota.

Cada incidente mantiene usuarios buscados, nivel de oleada, unidades y rutas.
Cada usuario conserva su propio nivel (0-5), secuencia y estado de escape.

## Movimiento

- `road`: el servidor solicita una ruta real a Valhalla sobre OpenStreetMap,
  recorre su polyline localmente y recalcula únicamente si el objetivo se mueve
  más que el umbral configurado o se agota la ruta. Peticiones iguales comparten
  caché e in-flight promise.
- `air`: interpola directamente mediante distancia, bearing y velocidad, sin
  llamadas de ruta.

Todas las rutas `road` requieren `GROUND_ROUTING_PROVIDER=valhalla` y
`VALHALLA_BASE_URL` apuntando al servicio interno existente en Render. El
extracto regional preparado cubre Espana, Canarias y Panama. Los proveedores
mapbox e hybrid se rechazan para impedir rutas de pago por error.

Las unidades se publican tras validar una posicion en una ruta real cerca del
incidente. La pareja patrulla siguiendo el mismo camino con separacion.
Si Valhalla falla, se reintenta sin llamar a ningun proveedor de pago.
Consulta [GROUND_ROUTING.md](GROUND_ROUTING.md) para el despliegue regional.

## Eventos Socket.IO

- Incidente: `police:trigger:scheduled`, `police:incident:spawn`,
  `police:incident:update`, `police:incident:end`.
- Oleada: `police:wave:scheduled`, `police:wave:spawn`.
- Unidad: `police:unit:spawn`, `police:unit:update`, `police:unit:target`,
  `police:unit:destroy`.
- Proyectil: `police:projectile:spawn`, `police:projectile:impact`,
  `police:projectile:cancel`.
- Usuario: `police:wanted:update`.

El ACK de `presence:hello` incluye `policeIncidents`, `policeUnits`,
`policeProjectiles` y `policeWanted`. Flutter descarta secuencias antiguas,
interpola únicamente lo confirmado y no aplica daño local.

## Limpieza

Muerte, escape total, desactivación del modo juego, background explícito,
desconexión sin socket alternativo o ausencia de usuarios buscados eliminan la
participación. Un incidente vacío cancela proyectiles, retira unidades, rutas y
referencias y emite su finalización. El runtime usa un único scheduler central,
sin temporizador por NPC o proyectil.
