# Rutas de NPC exclusivamente con Valhalla

Mapbox se usa para el mapa visual de Flutter. Las rutas de agentes, vehiculos
y otras unidades terrestres se calculan exclusivamente con Valhalla en el
servicio separado que ya existe en Render. Los proveedores hybrid y mapbox
se rechazan: no existe respaldo automatico que genere peticiones de pago.

Configurar el backend con GROUND_ROUTING_PROVIDER=valhalla y la URL interna
real del servicio Valhalla en VALHALLA_BASE_URL. Quitar los tokens de Mapbox
del backend; conservar el token de la app para mostrar el mapa.

Para preparar Espana (incluye Canarias) y Panama consultar
[la guia de despliegue](../infra/valhalla/README.md).

Las unidades terrestres se publican solo tras obtener una posicion sobre una
ruta cercana al incidente. El segundo agente sigue el camino del primero.
Si no hay ruta, se reintenta; no se atraviesa el agua en linea recta.

Comprobacion de cobertura: node scripts/check-valhalla-coverage.js
Pruebas: npm run test:routing y python -B test/valhalla_regions_test.py
