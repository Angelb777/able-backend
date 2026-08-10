# Flujo del rol Comercio

## Alcance

`CommercialRequest` centraliza posicionamientos, skins comerciales, armas comerciales y
descuentos/premios. No existe una pasarela de pago en este flujo. Toda solicitud con precio
empieza con `paymentStatus=pending` y solo un Superadmin puede confirmar manualmente un pago
con una referencia o marcarlo como exento.

Precios controlados por servidor:

- Skin comercial: 500 EUR.
- Arma corta: 250 EUR.
- Arma media: 350 EUR.
- Arma larga: 450 EUR.
- Posicionamiento: precio de la duración del `PromocionNegocio` vigente.

El comercio nunca envía estadísticas efectivas de un arma. Al publicar, Superadmin define
`dano`, `alcance` y `tiempoEspera`; el destino creado es un `Card` de tipo `Proyectil`. Las skins
se publican como `Skin`, los descuentos/premios como `Reward` y los posicionamientos como
`PromocionComprada`.

## Estados

Flujo habitual:

`pending_payment` -> `pending_material`/`pending_review` -> `approved` -> `published`.

Estados auxiliares: `changes_requested`, `rejected`, `disabled`, `withdrawn`, `renewal_due`,
`renewed` y `retired`. Las transiciones se validan en servidor y se registran en `history` junto
con `revision`. Una skin o arma publicada recibe `reviewDueAt` un año después de publicación,
pero ningún proceso la retira automáticamente. La decisión es manual desde Superadmin.

## Autorización

- `/api/commercial/establishment`, `/packages`, `/requests`: JWT de rol `comercio`.
- El propietario se obtiene siempre del JWT; no se acepta un `userId` libre.
- `/api/commercial/admin/*`: JWT de rol `admin`.
- `/api/promo-contratada` POST legacy conserva compatibilidad, pero ahora exige comercio
  autenticado y crea una solicitud pendiente; ya no crea un pago ni publica automáticamente.
- Los endpoints de canje de `Reward` comprueban JWT, rol y propiedad del comercio.

## Material y plantillas

Se aceptan PNG, JPEG, WebP, GIF, PDF y ZIP, hasta 20 MB por archivo y diez archivos por envío.
Se almacenan con el sistema GridFS existente. Configurar, si existen plantillas oficiales:

- `COMMERCIAL_SKIN_TEMPLATE_URL`
- `COMMERCIAL_WEAPON_TEMPLATE_URL`

## Migración legacy

Antes de aplicar, realizar backup de MongoDB y ejecutar el informe de solo lectura:

```bash
npm run commercial:audit
```

Después de revisar los conteos:

```bash
npm run commercial:migrate
```

El script es idempotente mediante `legacySource + legacyId`. Importa contratos de
posicionamiento y rewards comerciales existentes sin duplicarlos. Conserva sus destinos
originales y marca pagos históricos como `legacy_confirmed`. No intenta inferir como
"comerciales" skins o cartas antiguas que carezcan de una relación fiable con un comercio;
esas asociaciones requieren revisión manual.

## Operación pendiente

Hasta conectar la pasarela, Superadmin debe verificar externamente el cobro y usar
`confirm_payment` con una referencia. El sistema nunca interpreta la creación de una solicitud
como prueba de pago.
