# Valhalla para Able73

Este servicio calcula exclusivamente las rutas de entidades de IA sobre datos
OpenStreetMap. El mapa visual, Places y la navegacion del usuario siguen usando
Google.

## Primer arranque

Desde la raiz de `able-backend`:

```text
docker-compose -f docker-compose.valhalla.yml up -d
docker-compose -f docker-compose.valhalla.yml logs -f valhalla
```

Con Docker Compose v2, los mismos comandos se pueden ejecutar como
`docker compose` (sin guion).

En el primer arranque la imagen oficial `valhalla-scripted` descarga
`aragon-latest.osm.pbf` de Geofabrik y construye los tiles dentro de
`infra/valhalla/custom_files`. Puede tardar varios minutos. Los siguientes
arranques reutilizan el `valhalla_tiles.tar` mientras el PBF no cambie.

Comprueba el servicio con:

```text
curl http://127.0.0.1:8002/status
```

El backend ejecutado en el host usa `VALHALLA_BASE_URL=http://127.0.0.1:8002`.
Si backend y Valhalla comparten una red Docker, usa
`VALHALLA_BASE_URL=http://valhalla:8002` y no publiques el puerto fuera de esa
red.

## Actualizar OpenStreetMap

Deten el servicio, cambia temporalmente `force_rebuild` a `True`, arranca y
espera a que el healthcheck sea correcto. Despues vuelve a `False`. Conserva
una copia del directorio anterior para rollback antes de una actualizacion de
produccion.

Los datos de Geofabrik/OpenStreetMap requieren la atribucion correspondiente a
OpenStreetMap contributors. No uses el servidor publico de demostracion de
Valhalla para produccion.

## Produccion actual (Render)

El backend de Able73 es un Web Service de Render administrado desde el
Dashboard; este repositorio no contiene actualmente `render.yaml`, `Dockerfile`
ni un despliegue Compose del backend. Render no ejecuta este Compose como un
sidecar del Web Service existente.

Crea en el mismo workspace y region un **Private Service** independiente con:

- imagen: `ghcr.io/valhalla/valhalla-scripted:3.8.3`;
- puerto privado: `8002` (y `PORT=8002` en el servicio);
- healthcheck TCP de Render sobre ese puerto; los Private Services no admiten
  healthcheck HTTP configurable, por lo que `/status` se verifica desde Shell;
- disco persistente montado exactamente en `/custom_files` (5 GB recomendados);
- compute recomendado para construir Aragon: 2 CPU y 4 GB RAM;
- una sola instancia, porque el disco persistente no se comparte entre replicas.

Configura en ese Private Service las mismas variables `tile_urls`,
`serve_tiles`, `use_tiles_ignore_pbf`, `force_rebuild`, `build_tar`,
`build_elevation`, `build_admins`, `build_time_zones`,
`update_existing_config` y `server_threads` del Compose.

Cuando `/status` este sano, copia desde **Connect > Internal** la direccion real
asignada por Render. En el Web Service del backend configura:

```text
GROUND_ROUTING_PROVIDER=valhalla
VALHALLA_BASE_URL=http://<direccion-interna-de-render>:8002
VALHALLA_TIMEOUT_MS=1500
```

No uses `127.0.0.1`, el nombre Compose `valhalla` ni una URL publica en Render.
El backend y el Private Service deben estar en el mismo workspace y region para
que esa direccion resuelva por la red privada.
