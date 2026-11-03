# Identity Lab

Demo de registro y cotejo facial con face-api.js 0.22.2. Todas las entradas de captura (`/`, `/index.html` y `?flow=register`) activan el registro completo: ya no existe una entrada pública que omita el formulario y registre solamente en memoria. `/portal.html` ofrece QR, verificación y administración.

## Flujo de la persona

1. Autoriza la cámara y espera el contorno verde. Las instrucciones se muestran sobre la vista, antes del fotograma, y dentro de él.
2. La foto se toma **automáticamente** tras tres evaluaciones estables, el aviso «No te muevas», una pausa breve y una cuenta regresiva de tres segundos. El movimiento cancela el temporizador y permite reintentarlo al recuperar el encuadre. Cada fotograma se valida por tamaño, posición, pose e iluminación. La guía usa un óvalo más estrecho con coordenadas acordes a la resolución real del video.
3. La foto aceptada abre un formulario con miniatura, nombre, segundo nombre opcional, apellidos, nacimiento, documento, dirección y consentimiento. Confirmar los datos guarda la foto y el perfil. Cancelar descarta la foto temporal.
4. Tras guardar, la cámara se apaga y aparece «Continuar con la segunda foto» encima del video. Ese botón enciende y prepara la captura automática de una segunda imagen distinta. La opción permanente «Ya me registré · Comparar» abre la verificación de un registro existente sin volver a registrarse. En otra visita se selecciona el documento desde el flujo de verificación.
5. El servidor compara el descriptor nuevo con la única referencia. El usuario ve «Tu rostro coincide» o «No se confirmó la coincidencia» y un índice de similitud orientativo del 1 al 100%. Si coincide, aparecen los datos registrados. La captura de comparación solo se muestra en memoria en la pestaña, junto a la referencia y sus horas. Nunca se guarda en el servidor y se elimina al limpiar, repetir o cerrar. Los vectores temporales se ponen a cero tras la operación.

El índice usa `round(100 × exp(-ln(2) × (distancia/umbral)^2))`, limitado a 1–100. El umbral corresponde a 50 antes de redondear. **No es una probabilidad de identidad ni una precisión validada.** El resultado se decide con la distancia completa; el redondeo visual no determina aceptación. Distancia, umbral, fórmula y vectores quedan en la administración. La API de verificación pública omite los datos técnicos, incluso para la cuenta administradora; los endpoints técnicos exigen rol de administrador.

## Persistencia

- D1: perfil, consentimiento versionado, descriptor, sesiones QR, límites, pausas y auditoría.
- R2: una foto de referencia por perfil y el avatar administrativo opcional. Las fotos de verificación no se almacenan en el servidor.
- Los perfiles son únicos por cliente + tipo y número de documento normalizados; el índice almacena una clave hash. Reintentos con el mismo identificador son idempotentes.
- Actualizar la referencia requiere autorización administrativa previa. Se escribe una nueva revisión antes de reemplazar el puntero y eliminar la anterior; pueden coexistir dos archivos durante la operación. Fallos de limpieza devuelven `cleanupPending`; todavía no hay reconciliador automático.
- Los registros anteriores con tres referencias siguen funcionando usando la primera. El administrador dispone de «Conservar solo 1 foto» para borrar las otras dos sin perder los datos personales. No se borran esas fotos automáticamente al desplegar.

`server/storage.mjs` contiene el puerto de archivos y el adaptador de Sites. Drive **sigue pendiente de habilitación**; no se guarda en Drive ni hay selector directo de imágenes desde Drive. Las sesiones y contadores transaccionales permanecen en D1 aunque se cambie el adaptador de archivos. Cambiar de proveedor requiere implementación y migración; cambiar de modelo puede requerir nuevo registro.

## Administración y permisos

`ADMIN_EMAIL` es una variable exclusiva del servidor que identifica al administrador. La política de acceso de Sites se conserva. Un QR es temporal, de un solo uso, ligado a la sesión y con hash persistido; no sustituye los permisos del Site.

El panel lista personas y eventos; permite ver datos, foto y plantilla facial, desbloquear con motivo, autorizar actualización, reducir registros antiguos a una foto y eliminar perfiles. El avatar admite iconos o una imagen subida y recortada a 256×256, independiente de la biometría.

Valores iniciales configurables: tres fallos consecutivos, pausa de 15 minutos, QR de cinco minutos, umbral 0.50 y eventos durante 90 días. Las capturas rechazadas antes de comparar no cuentan como fallo. El servidor aplica el bloqueo; recargar la pantalla no lo reinicia. Una coincidencia reinicia el contador. Las pausas activas conservan su vencimiento si se cambia la configuración. La depuración de eventos vencidos requiere el botón administrativo; no hay tarea automática.

Las IP se guardan legibles desde los encabezados del borde confiable. `2800:…` es IPv6, **no texto cifrado**. Se etiqueta IPv4 o IPv6; una VPN/NAT o intermediario puede representar varios dispositivos. No prueba identidad ni ubicación exacta. No se usa un `X-Forwarded-For` aportado por el cliente.

## Límites del laboratorio

No tiene prueba de vida, verificación documental ni evidencia resistente a un cliente manipulado. Los datos del formulario son declarados. El procesamiento del descriptor ocurre en el navegador; la comparación y los permisos, en servidor. La autorización real depende de la cuenta de Sites y su sesión. Antes de proteger datos sensibles hacen falta evidencia biométrica verificable en servidor, medidas contra presentación y abuso, recuperación segura y evaluación de precisión/sesgos.

La publicación configura un solo cliente con datos y reglas separados por clave de cliente; no incluye un panel de alta de múltiples clientes. Ninguna foto, IP real, plantilla o credencial debe incluirse en Git.

## Desarrollo

Node 24 y Python 3:

```bash
npm ci
python scripts/download_assets.py
npm test
npm run build
```

En un clon nuevo, crear `.openai/hosting.json` desde `.openai/hosting.example.json`, sin copiar el identificador del Site original. Configurar `ADMIN_EMAIL` en el servidor. El entorno sin identidad válida responde 401; no habilitar bypass en producción.

Las migraciones de `drizzle/` se aplican por Sites al publicar. Para una base local nueva, aplicar cada SQL una vez antes del servidor:

```bash
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_acoustic_hawkeye.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0001_certain_madame_web.sql
npm run dev
```

Las pruebas usan SQLite real y un almacén de objetos de prueba. Cubren registro de una foto, rechazo de fotos extra, formulario tras la captura, cancelación, comparación fresca, descartado, porcentajes sin datos técnicos públicos, autorización, QR, límites, actualización y reducción de referencias antiguas. No miden precisión biométrica ni sustituyen pruebas con cámara real.

## Evidencia visible y repetición

La pantalla distingue foto 1 de registro, foto 2 nueva y resultado. La tarjeta «Continuar con la segunda foto» aparece encima del video al guardar o seleccionar un registro. La captura posterior es automática al recuperar el encuadre estable. Al terminar se apaga la cámara, se eliminan las indicaciones de captura activa y aparece «Hacer otra comparación», que requiere una nueva captura y conserva los contadores del servidor.

Al verificar un registro existente, la referencia se muestra solo después de una coincidencia mediante un endpoint ligado al actor, intento exitoso, archivo exacto utilizado y vigencia de cinco minutos. Un registro modificado, otra persona o un intento fallido no permiten descargar esa evidencia. Las miniaturas se muestran solo en la sesión actual; no se crea una galería persistente de comparaciones.

## Control de captura automática

El disparo automático es de una sola toma por paso. Solo se arma al activar la cámara para el paso correspondiente o mediante un reintento explícito; no encadena una segunda captura al cerrar el formulario. La aceptación del fotograma desarma el disparador antes de abrir el formulario o enviar una verificación. Cancelar el formulario o fallar el guardado no crea un bucle de nuevas fotos. Apagar, limpiar u ocultar la página cancela el temporizador y el disparador. El análisis en vivo y la inferencia siguen serializados.
