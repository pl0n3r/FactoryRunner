# AGENTES.md: FactoryRunner

> Antes de trabajar, lee y aplica https://github.com/pl0n3r/factory/blob/v1/agentes/NUCLEO.md y https://github.com/pl0n3r/factory/blob/main/PLAN-AGENTES.md.

## Contrato técnico local

- **Rol:** execution plane autónomo de la fábrica. ControlBot decide; FactoryRunner ejecuta.
- **Stack:** Node.js 24 LTS + TypeScript.
- **Target primario:** Hostinger Shared/Web Hosting en la infraestructura de `control.condorapp.com.co`.
- **Portabilidad:** no asumir root, Docker, Chromium local ni puertos entrantes. macOS local es fallback únicamente si una capability crítica resulta inviable en hosting.
- **Transporte:** HTTPS/polling/cron compatibles con shared hosting; adapters remotos para capabilities que requieran browser/OS fuera del host.
- **Estado durable:** vive en ControlBot. FactoryRunner debe ser reconstructible.
- **Seguridad:** ninguna orden, log o archivo versionado contiene passwords, cookies, private keys, tokens o DSN. Perfiles/cuentas se referencian por alias.
- **AutoFactory:** no se modifica, absorbe ni usa como dependencia del runtime autónomo; permanece herramienta local/manual del dueño.
- **Factory v1:** coordinación, etiquetas, política, aceptación, privacidad, CI y releases se consumen desde `pl0n3r/factory@v1`.
- **Fase:** construccion. No hay go-live ni browser automation real hasta tener adapters y políticas verificadas.

## Orden inicial

1. #1 — bootstrap Factory v1 + runtime contracts.
2. Identity/capabilities/heartbeat.
3. ExecutionOrder/ExecutionEvent.
4. adapters programáticos.
5. browser execution compatible con el target.
