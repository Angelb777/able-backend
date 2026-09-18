# Valhalla: Espana y Panama

La app muestra el mapa con Mapbox. Todas las rutas terrestres de NPC se
calculan exclusivamente en el servicio Valhalla existente de Render. No hay
respaldo a Directions API de Mapbox ni Google, ni tarifa por cada ruta.
El coste es el del servicio, disco y mantenimiento contratados en Render.

## Datos y construccion

La imagen preparada descarga Espana, Canarias y todo Panama (incluye la
capital). Geofabrik distribuye Canarias por separado del extracto de Espana.
Osmium une los extractos en un unico PBF antes de construir el grafo: Valhalla
3.8.3 desaconseja construir directamente con varios PBF.

Los datos y tiles nuevos se guardan en /custom_files/es-panama-v1. Los datos
antiguos de Aragon permanecen en /custom_files para poder volver atras.
Los originales se guardan en /custom_files/sources-es-panama-v1. Un reinicio
reutiliza los ficheros completos; no vuelve a descargar ni reconstruir datos
sin cambios. Las descargas y el merge se publican mediante renombrado atomico.

## Servicio EXISTENTE en Render

No crear otro servicio de rutas. El servicio comprobado es able73-valhalla,
srv-dac08aifngtc73fgumi0, en Oregon: 512 MB de RAM, imagen privada de GHCR
con Aragon incorporado y SIN disco persistente. El backend de produccion
ya usa http://able73-valhalla:8002 con GROUND_ROUTING_PROVIDER=valhalla.
Mantener el puerto 8002, la URL interna y inicialmente el plan actual.

Construir el grafo LOCALMENTE con Dockerfile (contexto: infra/valhalla).
No ejecutar esa construccion en el servicio de 512 MB. Despues construir
Dockerfile.runtime con contexto custom_files/es-panama-v1: incorpora solo
tiles, config, admins y zonas horarias; arranca directamente valhalla_service,
con un hilo y cache de 32 MB, sin descargas ni reconstruccion en Render.
Publicar esta imagen en GHCR y cambiar la referencia del MISMO servicio.
Verificar su consumo con limites de 512 MB antes del despliegue. La capacidad
real para atender rutas de ambas regiones debe medirse; no se garantiza que
512 MB basten solo por limitar la cache.

```sh
docker compose -f docker-compose.valhalla.yml build valhalla
docker compose -f docker-compose.valhalla.yml run --no-deps -e serve_tiles=False valhalla
docker build -f infra/valhalla/Dockerfile.runtime -t able73-valhalla:es-panama-runtime infra/valhalla/custom_files/es-panama-v1
```

Las variables siguientes son para CONSTRUIR localmente o para una instalacion
alternativa con disco persistente. No hacen falta en la imagen runtime.

Variables del servicio Valhalla:

```text
PORT=8002
path_extension=es-panama-v1
serve_tiles=True
use_tiles_ignore_pbf=False
force_rebuild=False
build_tar=True
build_elevation=False
build_admins=True
build_time_zones=True
update_existing_config=True
server_threads=2
```

Eliminar el tile_urls anterior de Aragon: el nuevo entrypoint obtiene los
extractos configurados y deja un solo PBF en el directorio del grafo.
La primera construccion tarda; los reinicios posteriores reutilizan el grafo.
Como presupuesto tecnico inicial LOCAL, reservar 8 GB de RAM y 50 GB de disco
para la construccion y sus temporales. Son estimaciones, no requisitos medidos.
El constructor de Compose tiene un limite de 8 GB.
No subir el plan ni anadir disco de Render sin aprobar su coste.

Variables del backend Able:

```text
GROUND_ROUTING_PROVIDER=valhalla
VALHALLA_BASE_URL=http://<direccion-interna-del-servicio-existente>:8002
VALHALLA_TIMEOUT_MS=1500
```

Desplegar el backend con GROUND_ROUTING_PROVIDER=valhalla. Los valores mapbox
e hybrid se rechazan para impedir activar por error rutas de pago. Quitar
MAPBOX_ACCESS_TOKEN y MAPBOX_ROUTING_TIMEOUT_MS del backend; conservar el token
de Mapbox en Flutter para mostrar el mapa. Ambos servicios deben poder acceder
por la red privada de Render. No sustituir la URL interna por localhost.

## Comprobacion

Desde la Shell del backend:

```sh
node scripts/check-valhalla-coverage.js
```

Verifica rutas walking y driving en Zaragoza, Barcelona, Las Palmas y Ciudad
de Panama usando la URL interna real. /status por si solo no verifica cobertura.
Hasta que estas rutas pasen no se considera completado el despliegue regional.
Si el servicio no devuelve ruta, la IA reintenta de forma segura y no llama
ningun proveedor de pago.

## Local

```sh
docker compose -f docker-compose.valhalla.yml up --build -d
docker compose -f docker-compose.valhalla.yml logs -f valhalla
```

Docker debe estar iniciado. Consultar docker logs para comprobar el progreso
y verificar que la construccion termina con codigo 0 antes de crear el runtime.
Probar la imagen runtime con --memory 512m --cpus 0.5 y ejecutar el script de
cobertura contra ella antes de sustituir la imagen de produccion.

## Actualizaciones y rollback

Para actualizar OSM, cambiar path_extension a es-panama-v2 (v3, etc.) y
reconstruir LOCALMENTE, publicar un runtime nuevo y desplegarlo. Se conserva
el dataset anterior. Vigilar espacio
antes de mantener multiples versiones. No dejar force_rebuild=True.
Para rollback, restaurar la referencia de la imagen runtime anterior.
La imagen original de produccion comprobada es
ghcr.io/angelb777/able73-valhalla@sha256:ec2c47755cc52782b4f9246772355ef6ab2bf260d26ff185daca9ae14801cf5d.

## Fuentes

- https://download.geofabrik.de/europe/spain.html
- https://download.geofabrik.de/africa/canary-islands.html
- https://download.geofabrik.de/central-america/panama.html
- https://raw.githubusercontent.com/valhalla/valhalla/3.8.3/docker/README.md
- https://docs.osmcode.org/osmium/latest/osmium-merge.html
