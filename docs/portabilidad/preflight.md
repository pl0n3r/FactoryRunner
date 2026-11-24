# FactoryRunner: preflight portable, solo offline (#716)

Este primer slice de #711 es un inventario **local, sin efectos**. No instala nada,
no arranca FactoryRunner, no comprueba ControlBot ni el acceso a proveedores. Nunca
acredita READY, restauración, privacidad operativa, producción ni failover.

## Uso en una copia local ya descargada del repositorio

1. Instalar Node.js 24 y Git en el equipo por el mecanismo aprobado localmente.
2. Ejecutar **node --experimental-strip-types scripts/portable-preflight.ts** desde
   la raíz del repositorio. No requiere npm install, Docker, root ni conexión.
3. La salida es **un solo JSON sanitizado** y el exit code es 0 solo si Node 24,
   la familia OS/arquitectura y Git local se clasifican SUPPORTED_OFFLINE.
   Con UNAVAILABLE/UNKNOWN, se devuelve exit code 1 sin mensajes crudos.
4. Smoke sintético: **node --experimental-strip-types --test tests/portable-preflight.test.ts**.
   Typecheck/build del repo: **npm ci && npm run typecheck && npm run build**;
   npm ci **sí** puede usar red, por lo que no forma parte del preflight.

La fuente de requisitos es package.json: engines.node >=24; la compatibilidad
**solo está ensayada en Node 24**, no se presume Node 25+. Git es requerido para
el adapter git-read, aunque no para todos los contratos del runtime. Docker y
WSL2 son opcionales: se comprueba la presencia del CLI de Docker, **no el daemon**;
WSL2 se reconoce solo por un kernel Linux que se identifica explícitamente como
WSL2. No se ejecuta Docker, WSL, navegador ni comandos de instalación.

| Entorno objetivo | Lectura offline | Validación de instalación real |
| --- | --- | --- |
| macOS Apple Silicon (arm64) | Familia/arquitectura reconocidas | NO ACREDITADA |
| macOS Intel (x64) | Familia/arquitectura reconocidas | NO ACREDITADA |
| Linux AMD64 (x64) | Familia/arquitectura reconocidas | NO ACREDITADA |
| Linux ARM64 | Familia/arquitectura reconocidas | NO ACREDITADA |
| Windows + WSL2 | Ejecutar desde Linux WSL2; Windows nativo no es target | NO ACREDITADA |

SUPPORTED_OFFLINE **no significa compatibilidad ensayada** en esas cinco variantes:
solo describe evidencia local suficiente para el inventario sin red. UNKNOWN
implica evidencia ambigua o sin comprobar y no concede permisos. Las capacidades
browser-remote, programmatic, recovery remoto y las macOS-only no se activan
ni se certifican. No exportar el JSON junto a datos reales; no contiene hostname,
rutas, usuario, variables de entorno, stdout/stderr de ejecutables ni tokens.

**Continuidad y recuperación:** siguen separadas las puertas de #465/#606/#607;
este inventario no sustituye la identidad nueva de runner, backup externo cifrado,
fencing, autoridad o restore medido del épico #711. Reversión: retirar únicamente
los tres archivos de #716 mediante revert del PR, sin cambiar datos durables.
