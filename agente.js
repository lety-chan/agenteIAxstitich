import { StitchToolClient } from "@google/stitch-sdk";
import OpenAI from "openai";
import dotenv from "dotenv";

// Cargar variables del archivo .env
dotenv.config();

// Inicializar el cliente de OpenAI apuntando a OpenRouter
const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});

async function iniciarAgente() {
  console.log("Iniciando conexión con Stitch MCP...");

  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("Falta configurar OPENROUTER_API_KEY en el archivo .env.");
  }

  if (!process.env.STITCH_API_KEY) {
    throw new Error("Falta configurar STITCH_API_KEY en el archivo .env.");
  }

  const modelo = process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-4.6";
  const maxTokens = Number(process.env.OPENROUTER_MAX_TOKENS ?? 1024);
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    throw new Error(
      "OPENROUTER_MAX_TOKENS debe ser un entero positivo.",
    );
  }

  const stitchClient = new StitchToolClient({
    apiKey: process.env.STITCH_API_KEY,
  });

  try {
    // Solo enviar las herramientas necesarias para crear el proyecto y la pantalla.
    const herramientasNecesarias = new Set([
      "create_project",
      "generate_screen_from_text",
    ]);
    const stitchTools = await stitchClient.listTools();
    const toolsDisponibles = stitchTools.tools.filter((tool) =>
      herramientasNecesarias.has(tool.name),
    );
    if (toolsDisponibles.length !== herramientasNecesarias.size) {
      throw new Error(
        "Stitch no devolvió todas las herramientas necesarias para crear el proyecto y la pantalla.",
      );
    }
    const openRouterTools = toolsDisponibles.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));

    console.log(
      `Conexión exitosa. ${openRouterTools.length} herramientas necesarias disponibles.`,
    );

    const mensajes = [
      {
        role: "system",
        content: `Eres un Ingeniero Frontend y Experto en UX/UI.
Tu objetivo es traducir los requerimientos del usuario en interfaces funcionales usando las herramientas de Stitch.
Reglas:
1. Analiza el requerimiento y decide qué herramientas usar.
2. Si una herramienta falla, lee el error, ajusta los parámetros y vuelve a intentarlo.
3. Informa al usuario de tus acciones de forma concisa.`,
      },
      {
        role: "user",
        content:
          "Crea un proyecto nuevo y genera una pantalla de inicio de sesión, la cual reciba un usuario y password, así como las opciones de registrarse, olvidé mi contraseña y recordar sesión siempre.",
      },
    ];

    let tareaCompletada = false;

    while (!tareaCompletada) {
      let respuesta;
      let reintentosPorSolicitudesEnCurso = 0;
      while (!respuesta) {
        try {
          respuesta = await openai.chat.completions.create({
            model: modelo,
            messages: mensajes,
            tools: openRouterTools,
            max_tokens: maxTokens,
          });
        } catch (error) {
          if (
            error.status === 404 &&
            error.error?.message?.includes("No endpoints found")
          ) {
            throw new Error(
              `OpenRouter no tiene endpoints para el modelo "${modelo}". ` +
                "Configura OPENROUTER_MODEL en .env con un modelo disponible que admita herramientas.",
              { cause: error },
            );
          }
          if (error.status === 402) {
            const mensajeError = error.error?.message || "";
            if (mensajeError.includes("in-flight requests")) {
              const segundosDeEspera = Number(
                error.headers?.get("retry-after"),
              );
              if (
                !Number.isFinite(segundosDeEspera) ||
                segundosDeEspera <= 0
              ) {
                throw new Error(
                  "OpenRouter tiene solicitudes anteriores en curso, pero no indicó cuánto esperar. " +
                    "Espera un momento antes de volver a intentarlo.",
                  { cause: error },
                );
              }
              if (reintentosPorSolicitudesEnCurso >= 3) {
                throw new Error(
                  "OpenRouter sigue esperando solicitudes anteriores después de 3 reintentos. " +
                    "Espera a que terminen antes de iniciar otra ejecución del agente.",
                  { cause: error },
                );
              }

              reintentosPorSolicitudesEnCurso += 1;
              console.log(
                `OpenRouter tiene solicitudes anteriores en curso. Reintento ${reintentosPorSolicitudesEnCurso}/3 en ${segundosDeEspera} segundos...`,
              );
              await new Promise((resolve) =>
                setTimeout(resolve, segundosDeEspera * 1000),
              );
              continue;
            }
            if (mensajeError.includes("fewer max_tokens")) {
              throw new Error(
                `OpenRouter no puede reservar ${maxTokens} tokens con los créditos disponibles. ` +
                  "El error indica cuántos tokens sí puedes solicitar; configura OPENROUTER_MAX_TOKENS por debajo de ese límite en .env.",
                { cause: error },
              );
            }
            if (mensajeError.includes("Prompt tokens limit exceeded")) {
              throw new Error(
                "OpenRouter rechazó la solicitud porque el texto de entrada supera el límite de tokens del modelo. " +
                  "El agente ya limita las herramientas a las necesarias; prueba un modelo con mayor contexto.",
                { cause: error },
              );
            }
            throw new Error(
              `OpenRouter rechazó la solicitud por créditos insuficientes. ` +
                "Reduce OPENROUTER_MAX_TOKENS en .env o agrega créditos en https://openrouter.ai/settings/credits.",
              { cause: error },
            );
          }
          throw error;
        }
      }

      const mensajeModelo = respuesta.choices[0].message;
      mensajes.push(mensajeModelo);

      if (mensajeModelo.tool_calls && mensajeModelo.tool_calls.length > 0) {
        for (const toolCall of mensajeModelo.tool_calls) {
          console.log(
            `\nAcción del Agente -> Ejecutando: ${toolCall.function.name}`,
          );
          try {
            const argumentos = JSON.parse(toolCall.function.arguments);
            const resultado = await stitchClient.callTool(
              toolCall.function.name,
              argumentos,
            );

            mensajes.push({
              role: "tool",
              tool_call_id: toolCall.id,
              name: toolCall.function.name,
              content: JSON.stringify(resultado),
            });

            console.log("Acción completada con éxito.");
          } catch (error) {
            console.log(
              `Error en la herramienta: ${error.message}. Informando al agente para que corrija...`,
            );
            mensajes.push({
              role: "tool",
              tool_call_id: toolCall.id,
              name: toolCall.function.name,
              content: `Error: ${error.message}`,
            });
          }
        }
      } else {
        console.log(`\nAgente: ${mensajeModelo.content}`);
        tareaCompletada = true;
      }
    }
  } finally {
    await stitchClient.close();
  }
}

iniciarAgente().catch((error) => {
  console.error("Error al ejecutar el agente:", error);
  process.exitCode = 1;
});