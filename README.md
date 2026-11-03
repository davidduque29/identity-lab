# Identity Lab

Laboratorio de captura y cotejo facial con face-api.js 0.22.2. El inicio es `/portal.html`; `/index.html` conserva el experimento local y `?flow=register` / `?flow=verify` activan el flujo persistente.

## Flujo

1. Una cuenta autorizada abre el portal y genera un QR de registro o verificación, o usa el mismo equipo.
2. El QR contiene un token aleatorio en el fragmento del enlace, caduca y se reclama una sola vez. El servidor almacena su hash. El celular debe tener acceso al Site; el QR no cambia permisos de Sites.
3. La primera referencia aceptada abre el formulario de datos y consentimiento. Después se toman las otras dos fotos, con encuadre validado. El guardado se confirma únicamente al completar las tres muestras y la escritura persistente.
4. Tipo y número de documento normalizados producen una clave única por cliente. Reintentos con el mismo identificador no crean otro registro.
5. La verificación selecciona un registro accesible a la cuenta, toma una foto nueva y envía solo su descriptor. El servidor calcula la media de las distancias contra las tres referencias y decide con su propia configuración. La foto temporal se descarta, incluso si ocurre un error.
6. Una coincidencia muestra los datos en el celular o equipo donde se capturó. El computador que generó el QR solo recibe el estado; no recibe fotos ni datos personales por el canal de seguimiento.

## Persistencia y adaptadores

- D1: perfiles, consentimiento, plantillas versionadas, sesiones QR, reglas, contadores y auditoría.
- R2: tres referencias por registro y la foto administrativa opcional, en rutas privadas con ID interno. No hay un endpoint público de fotos.
- `server/storage.mjs`: puerto de archivos con adaptador funcional de Sites. `DriveStorage` informa explícitamente que falta habilitación; **no está conectado ni guarda en Drive**. El selector directo de avatar desde Drive tampoco está disponible; se puede descargar una imagen de Drive y subirla desde el equipo.
- `server/domain.mjs`: validación, modelo/versionado, comparación y reglas independientes de HTTP y almacenamiento.
- `server/lab.mjs`: servicio HTTP, autorización, operaciones SQL atómicas y orquestación.
- `public/app.js`: adaptador del motor facial, encuadre y captura. `public/workflow.js`: formulario e integración del flujo persistente. `public/portal.js`: QR y administración.

Los archivos se guardan mediante el puerto de almacenamiento; los contadores y las sesiones requieren persistencia transaccional. Cambiar el almacenamiento de archivos no migra los perfiles ni la base de datos operativa. Un destino nuevo requiere su implementación, permisos y migración; no basta con cambiar una etiqueta. Los datos y reglas están aislados por cliente en el esquema; esta publicación configura un único cliente. No incluye alta o gestión de múltiples clientes.

## Reglas y administración

La variable de servidor `ADMIN_EMAIL` determina la cuenta administrativa; no se acepta un rol enviado por el navegador. Sites conserva además su política de acceso original.

El panel permite listar perfiles, consultar datos, buscar en la página, ver eventos y sus IP, desbloquear con motivo, autorizar reemplazo de referencias, eliminar perfiles, elegir un avatar o subir una imagen recortada a 256×256. Los controles del servidor deniegan estas acciones a otros visitantes.

Valores iniciales: tres fallos consecutivos, pausa de 15 minutos, QR de cinco minutos, umbral de 0.50 y plazo de eventos de 90 días. Son configurables con límites. Las capturas rechazadas antes de comparar no incrementan fallos. Una coincidencia reinicia el contador. Cambiar reglas no acorta una pausa ya activa. La depuración de eventos vencidos se ejecuta mediante una acción explícita del administrador; no hay tarea automática programada.

La actualización de referencias exige autorización y reemplaza las tres muestras solo tras confirmar la escritura completa. Una operación fallida conserva las referencias previas. Los objetos nuevos se escriben en una revisión temporal antes de cambiar el puntero del registro: durante el reemplazo pueden coexistir temporalmente seis archivos. Si falla la limpieza posterior, el servidor devuelve `cleanupPending`; no hay reconciliador automático aún. El cliente informa esta situación al administrador. El registro activo mantiene tres referencias. La eliminación borra perfil, plantillas y fotos; conserva eventos sin nombre ni documento, solo ID interno y contexto de acceso, hasta su depuración.

## Límites de seguridad

Es una demo: no tiene prueba de vida ni verificación del documento. Los vectores se extraen en el navegador y no constituyen evidencia resistente a un cliente manipulado. La autorización real de los datos depende del acceso de Sites y la cuenta/sesión, no de una autenticación biométrica de producción. Antes de usar con información sensible hacen falta inferencia o evidencia verificable en servidor, protección contra presentación y abuso, recuperación segura, cifrado y gestión de claves según el cliente, y evaluación de precisión y sesgos.

La IP se obtiene de los encabezados del borde confiable, sin usar un `X-Forwarded-For` enviado por el cliente. Puede representar una VPN, NAT o intermediario; no prueba identidad ni ubicación exacta.

No se deben subir fotos, documentos, vectores reales, credenciales o estados locales al repositorio. La foto administrativa se guarda separada de la biometría.

## Ejecutar y verificar

Requiere Node 24 (las pruebas de integración usan `node:sqlite`) y Python 3. Instala las dependencias y modelos verificados:

```bash
npm ci
python scripts/download_assets.py
```

En un clon nuevo crea `.openai/hosting.json` a partir de `.openai/hosting.example.json`, sin reutilizar el identificador de otro Site. La publicación original conserva su propio identificador. Configura `ADMIN_EMAIL` únicamente como variable de servidor para el entorno autorizado. La ejecución local sin identidad debe responder 401; nunca habilites un bypass de identidad en producción.

```bash
npm test
npm run db:generate
npm run build
```

Las migraciones generadas están en `drizzle/`. El despliegue de Sites aplica las migraciones en el servidor. Para un entorno local nuevo, aplica cada migración una sola vez con Wrangler y el archivo `dist/server/wrangler.json`, por ejemplo:

```bash
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_acoustic_hawkeye.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0001_certain_madame_web.sql
npm run dev
```

`python -m http.server 8000 --directory public` sirve únicamente el laboratorio local. QR, perfiles, administración y persistencia requieren el servidor Worker y una identidad válida de Sites.

Las pruebas cubren encuadre, captura, cancelación, comparación, unicidad, idempotencia, pausas, permisos, QR y sustitución/eliminación con SQLite real y un almacén de objetos de prueba. No miden precisión biométrica ni sustituyen pruebas con cámaras y celulares reales.
