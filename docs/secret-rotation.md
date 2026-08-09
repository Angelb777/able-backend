# Rotacion de secretos antes de produccion

El archivo `.env` estuvo versionado. Dejar de rastrearlo evita nuevas fugas,
pero no elimina sus valores del historial existente.

Rotar, en este orden:

1. `JWT_SECRET`: invalida sesiones; desplegar y exigir un nuevo login.
2. `MONGO_URI`: crear credenciales de minimo privilegio y revocar las antiguas
   despues de verificar el despliegue.
3. `PAYPAL_CLIENT_ID` y `PAYPAL_SECRET`: rotarlos al retomar pagos. Este cambio
   no completa ni modifica la integracion pendiente.
4. Limitar `ALLOWED_ORIGINS` a los dominios reales de staging y produccion.

Usos actuales:

- `JWT_SECRET`: REST, Socket.IO y emision de JWT.
- `MONGO_URI`: servidor, migraciones, seed y creacion de admin.
- `PAYPAL_*`: `api/routes/paypal.js`.
- `ALLOWED_ORIGINS`: CORS en `server.js`.

Eliminar los valores del historial exige una reescritura coordinada (por
ejemplo con `git filter-repo`) y force-push. No se ha ejecutado aqui.
