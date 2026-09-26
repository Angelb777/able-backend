# Uber Riders en Able73

## Diseño

Uber es un cuarto modo independiente. Los modos `pedestrian`, `bicycle` y
`auto` continúan usando exclusivamente Valhalla y el renderizado existente de
Mapbox/Google Maps. Uber no inicia navegación Able, no altera el GPS y no entra
en el cálculo de Stepcoins.

Flutter solo llama a `/api/uber/*` usando la sesión Able. El backend obtiene y
renueva tokens OAuth de Uber, llama a Riders API y devuelve DTOs sin secretos.
Los access/refresh tokens se guardan cifrados con AES-256-GCM en
`UberConnection`; el `client_secret` y la clave de cifrado solo existen en
variables de entorno del backend.

El estado del viaje se consulta cada cuatro segundos mediante el endpoint de
detalle de solicitud. No se usa `GET /requests/{id}/map`, ni los webhooks de
estado antiguos, ni endpoints de confirmación de surge deprecados.

## Scopes vigentes

- Client Credentials: `ride_request.estimate`.
- Consentimiento del rider: `ride_request.ride_booking`,
  `ride_request.user_payment_methods`, `offline_access`.

No se solicita `profile`, historial, recibos ni acceso a tarjetas.

## Endpoints Uber

- OAuth: `GET /oauth/v2/authorize`, `POST /oauth/v2/token`,
  `POST /oauth/v2/revoke`.
- Catálogo: `GET /v1.2/products`.
- Estimaciones: `GET /v1.2/estimates/time`,
  `GET /v1.2/estimates/price`, `POST /v1.2/requests/estimate`.
- Pagos: `GET /v1.2/payment-methods` (solo identificador y descripción
  ofuscada devueltos por Uber).
- Viajes: `POST /v1.2/requests`, `GET /v1.2/requests/{request_id}`,
  `GET /v1.2/requests/current`, `DELETE /v1.2/requests/{request_id}` o
  `DELETE /v1.2/requests/current`.

## Variables de Render

```text
UBER_API_ENV=sandbox
UBER_CLIENT_ID=...
UBER_CLIENT_SECRET=...
UBER_REDIRECT_URI=https://TU-SERVICIO.onrender.com/api/uber/oauth/callback
UBER_TOKEN_ENCRYPTION_KEY=...  # 32 bytes base64 o 64 caracteres hex
UBER_HTTP_TIMEOUT_MS=10000
```

No cambies `UBER_TOKEN_ENCRYPTION_KEY` con conexiones existentes: antes debes
desconectar esas cuentas o migrar/re-cifrar los tokens.

## Dashboard y Limited Access

1. Crea/abre la aplicación en Uber Developer Dashboard.
2. Registra exactamente la URL HTTPS de `UBER_REDIRECT_URI` como redirect URI.
3. Habilita los cuatro scopes indicados arriba.
4. Añade las cuentas de prueba como developers/admins autorizados de la app.
5. Configura Render con las variables y despliega primero con
   `UBER_API_ENV=sandbox`.
6. Autoriza una cuenta de desarrollo desde Able y prueba producto, pago,
   estimación, reserva, recuperación tras pérdida de red y cancelación.
7. Para una prueba real limitada cambia a `UBER_API_ENV=production`; una
   reserva real puede movilizar un conductor y generar cargos.

## Full Access

Publica además una política de privacidad accesible por HTTPS que explique el
uso, almacenamiento, revocación y eliminación de la conexión/datos Uber, y
registra esa URL en la ficha de la aplicación.

La implementación técnica queda preparada, pero Uber debe aprobar Full Access
para que los scopes privilegiados funcionen con riders ajenos al equipo de
desarrollo. La solicitud debe incluir vídeo/capturas del consentimiento,
selección, confirmación, estados, conductor/vehículo, cancelación, errores y la
declaración de que Uber procesa el pago. Tras la aprobación solo hay que usar
`UBER_API_ENV=production` y las credenciales de producción aprobadas; no hace
falta sustituir el flujo por un deep link.
