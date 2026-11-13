/**
 * Illuci — UE5 MCP Tool Contract
 *
 * Contingent skill: activates when UE5 editor is running with
 * the UnrealMCP plugin (TCP server on port 55557).
 * Gives models programmatic access to Unreal Engine 5 for:
 *   - Actor spawning, deletion, transform, properties
 *   - Blueprint creation, components, node graph editing
 *   - Viewport control and screenshots
 *   - UMG widget creation and binding
 *
 * Wire protocol: JSON over TCP, one connection per command.
 * Format: {"type": "<command>", "params": {...}} → JSON response
 *
 * Replaces the dead Ludus AI cloud bridge. Any seated model
 * (Claude, Grok, etc.) can invoke these tools — UE5 is no
 * longer a model, it's a tool layer.
 */

import net from "net";
import { logDecision } from "../decisions/logger.js";

const UE5_HOST = process.env.UE5_MCP_HOST || "127.0.0.1";
const UE5_PORT = parseInt(process.env.UE5_MCP_PORT || "55557", 10);

let available = null;

// ─── TCP CLIENT ───

/**
 * Send a single command to the UE5 MCP plugin over TCP.
 * Each command opens a fresh connection (UE5 closes after each).
 */
function sendCommand(command, params = {}) {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    const chunks = [];
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        sock.destroy();
        reject(new Error(`UE5 MCP timeout: ${command}`));
      }
    }, 15000);

    sock.setNoDelay(true);

    sock.connect(UE5_PORT, UE5_HOST, () => {
      const payload = JSON.stringify({ type: command, params });
      sock.write(payload);
    });

    sock.on("data", (chunk) => {
      chunks.push(chunk);
      // Try to parse — UE5 sends complete JSON then closes
      const data = Buffer.concat(chunks).toString("utf-8");
      try {
        const parsed = JSON.parse(data);
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          sock.destroy();

          // Normalize error shapes
          if (parsed.status === "error" || parsed.success === false) {
            const msg = parsed.error || parsed.message || "Unknown UE5 error";
            resolve({ success: false, error: msg });
          } else {
            resolve({ success: true, result: parsed.result || parsed });
          }
        }
      } catch {
        // Incomplete JSON — keep reading
      }
    });

    sock.on("close", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        const data = Buffer.concat(chunks).toString("utf-8");
        if (data.length > 0) {
          try {
            const parsed = JSON.parse(data);
            resolve({ success: true, result: parsed.result || parsed });
          } catch {
            reject(new Error(`UE5 MCP invalid response: ${data.substring(0, 200)}`));
          }
        } else {
          reject(new Error("UE5 MCP connection closed with no data"));
        }
      }
    });

    sock.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(err);
      }
    });
  });
}

// ─── AVAILABILITY CHECK ───

/**
 * Check if UE5 editor is running with the UnrealMCP plugin.
 * TCP probe to port 55557.
 */
export async function checkAvailability() {
  if (available !== null) return available;

  try {
    // Send a harmless read-only command to verify the plugin is alive
    const resp = await sendCommand("get_actors_in_level", {});
    available = true;
    return true;
  } catch {
    available = false;
    return false;
  }
}

/**
 * Reset cached availability (call when you want to re-probe).
 */
export function resetAvailability() {
  available = null;
}

// ─── TOOL IMPLEMENTATIONS ───

async function toolCheck() {
  resetAvailability();
  const up = await checkAvailability();
  return { success: true, result: { available: up, host: UE5_HOST, port: UE5_PORT } };
}

// -- Actor management --

async function toolGetActors() {
  const resp = await sendCommand("get_actors_in_level", {});
  return resp;
}

async function toolFindActors(params) {
  return sendCommand("find_actors_by_name", { pattern: params.pattern });
}

async function toolSpawnActor(params) {
  return sendCommand("spawn_actor", {
    name: params.name,
    type: params.type,
    location: params.location || [0, 0, 0],
    rotation: params.rotation || [0, 0, 0],
  });
}

async function toolDeleteActor(params) {
  return sendCommand("delete_actor", { name: params.name });
}

async function toolSetTransform(params) {
  const p = { name: params.name };
  if (params.location) p.location = params.location;
  if (params.rotation) p.rotation = params.rotation;
  if (params.scale) p.scale = params.scale;
  return sendCommand("set_actor_transform", p);
}

async function toolGetProperties(params) {
  return sendCommand("get_actor_properties", { name: params.name });
}

async function toolSetProperty(params) {
  return sendCommand("set_actor_property", {
    name: params.name,
    property_name: params.property_name,
    property_value: params.property_value,
  });
}

// -- Blueprint management --

async function toolCreateBlueprint(params) {
  return sendCommand("create_blueprint", {
    name: params.name,
    parent_class: params.parent_class || "Actor",
  });
}

async function toolAddComponent(params) {
  return sendCommand("add_component_to_blueprint", {
    blueprint_name: params.blueprint_name,
    component_type: params.component_type,
    component_name: params.component_name,
  });
}

async function toolCompileBlueprint(params) {
  return sendCommand("compile_blueprint", {
    blueprint_name: params.blueprint_name,
  });
}

async function toolSetBlueprintProperty(params) {
  return sendCommand("set_blueprint_property", {
    blueprint_name: params.blueprint_name,
    property_name: params.property_name,
    property_value: params.property_value,
  });
}

async function toolSpawnBlueprintActor(params) {
  return sendCommand("spawn_blueprint_actor", {
    blueprint_name: params.blueprint_name,
    actor_name: params.actor_name,
    location: params.location || [0, 0, 0],
    rotation: params.rotation || [0, 0, 0],
  });
}

// -- Blueprint node graph --

async function toolAddEventNode(params) {
  return sendCommand("add_blueprint_event_node", {
    blueprint_name: params.blueprint_name,
    event_type: params.event_type,
  });
}

async function toolAddFunctionNode(params) {
  return sendCommand("add_blueprint_function_node", {
    blueprint_name: params.blueprint_name,
    target: params.target,
    function_name: params.function_name,
  });
}

async function toolConnectNodes(params) {
  return sendCommand("connect_blueprint_nodes", {
    blueprint_name: params.blueprint_name,
    source_node_id: params.source_node_id,
    source_pin: params.source_pin,
    target_node_id: params.target_node_id,
    target_pin: params.target_pin,
  });
}

async function toolAddVariable(params) {
  return sendCommand("add_blueprint_variable", {
    blueprint_name: params.blueprint_name,
    variable_name: params.variable_name,
    variable_type: params.variable_type,
  });
}

async function toolFindNodes(params) {
  return sendCommand("find_blueprint_nodes", {
    blueprint_name: params.blueprint_name,
    node_type: params.node_type,
    event_type: params.event_type,
  });
}

// -- UMG widgets --

async function toolCreateWidget(params) {
  return sendCommand("create_umg_widget_blueprint", {
    widget_name: params.widget_name,
    parent_class: params.parent_class || "UserWidget",
    path: params.path || "/Game/UI",
  });
}

async function toolAddWidgetToViewport(params) {
  return sendCommand("add_widget_to_viewport", {
    widget_name: params.widget_name,
    z_order: params.z_order || 0,
  });
}

// -- Editor / viewport --

async function toolFocusViewport(params) {
  const p = {};
  if (params.target) p.target = params.target;
  if (params.location) p.location = params.location;
  if (params.distance) p.distance = params.distance;
  if (params.orientation) p.orientation = params.orientation;
  return sendCommand("focus_viewport", p);
}

async function toolScreenshot(params) {
  return sendCommand("take_screenshot", {
    filename: params.filename || "illuci_capture",
    show_ui: params.show_ui !== undefined ? params.show_ui : false,
    resolution: params.resolution || [1920, 1080],
  });
}

// -- Input mapping --

async function toolCreateInputMapping(params) {
  return sendCommand("create_input_mapping", {
    action_name: params.action_name,
    key: params.key,
    input_type: params.input_type || "Action",
  });
}

// ─── TOOL REGISTRATION ───

/**
 * Get tool definitions for registration in the tool system.
 * Only returns tools if UE5 editor is running.
 */
export async function getTools() {
  const up = await checkAvailability();
  if (!up) return {};

  return {
    // -- Health --
    ue5_check: {
      name: "ue5_check",
      description: "Check UE5 editor connection status",
      gated: false,
      handler: toolCheck,
    },

    // -- Actors (read) --
    ue5_get_actors: {
      name: "ue5_get_actors",
      description: "List all actors in the current UE5 level",
      gated: false,
      handler: toolGetActors,
    },
    ue5_find_actors: {
      name: "ue5_find_actors",
      description: "Find actors by name pattern: { pattern }",
      gated: false,
      handler: toolFindActors,
    },
    ue5_get_properties: {
      name: "ue5_get_properties",
      description: "Get all properties of an actor: { name }",
      gated: false,
      handler: toolGetProperties,
    },

    // -- Actors (mutate) --
    ue5_spawn_actor: {
      name: "ue5_spawn_actor",
      description: "Spawn an actor in the level: { name, type, location?, rotation? }",
      gated: true,
      handler: toolSpawnActor,
    },
    ue5_delete_actor: {
      name: "ue5_delete_actor",
      description: "Delete an actor from the level: { name }",
      gated: true,
      handler: toolDeleteActor,
    },
    ue5_set_transform: {
      name: "ue5_set_transform",
      description: "Set actor transform: { name, location?, rotation?, scale? }",
      gated: true,
      handler: toolSetTransform,
    },
    ue5_set_property: {
      name: "ue5_set_property",
      description: "Set an actor property: { name, property_name, property_value }",
      gated: true,
      handler: toolSetProperty,
    },

    // -- Blueprints --
    ue5_create_blueprint: {
      name: "ue5_create_blueprint",
      description: "Create a Blueprint class: { name, parent_class? }",
      gated: true,
      handler: toolCreateBlueprint,
    },
    ue5_add_component: {
      name: "ue5_add_component",
      description: "Add component to Blueprint: { blueprint_name, component_type, component_name }",
      gated: true,
      handler: toolAddComponent,
    },
    ue5_compile_blueprint: {
      name: "ue5_compile_blueprint",
      description: "Compile a Blueprint: { blueprint_name }",
      gated: true,
      handler: toolCompileBlueprint,
    },
    ue5_set_blueprint_property: {
      name: "ue5_set_blueprint_property",
      description: "Set Blueprint property: { blueprint_name, property_name, property_value }",
      gated: true,
      handler: toolSetBlueprintProperty,
    },
    ue5_spawn_blueprint_actor: {
      name: "ue5_spawn_blueprint_actor",
      description: "Spawn actor from Blueprint: { blueprint_name, actor_name, location?, rotation? }",
      gated: true,
      handler: toolSpawnBlueprintActor,
    },

    // -- Blueprint node graph --
    ue5_add_event_node: {
      name: "ue5_add_event_node",
      description: "Add event node to Blueprint graph: { blueprint_name, event_type }",
      gated: true,
      handler: toolAddEventNode,
    },
    ue5_add_function_node: {
      name: "ue5_add_function_node",
      description: "Add function call node: { blueprint_name, target, function_name }",
      gated: true,
      handler: toolAddFunctionNode,
    },
    ue5_connect_nodes: {
      name: "ue5_connect_nodes",
      description: "Connect Blueprint nodes: { blueprint_name, source_node_id, source_pin, target_node_id, target_pin }",
      gated: true,
      handler: toolConnectNodes,
    },
    ue5_add_variable: {
      name: "ue5_add_variable",
      description: "Add variable to Blueprint: { blueprint_name, variable_name, variable_type }",
      gated: true,
      handler: toolAddVariable,
    },
    ue5_find_nodes: {
      name: "ue5_find_nodes",
      description: "Find nodes in Blueprint graph: { blueprint_name, node_type?, event_type? }",
      gated: false,
      handler: toolFindNodes,
    },

    // -- UMG widgets --
    ue5_create_widget: {
      name: "ue5_create_widget",
      description: "Create UMG Widget Blueprint: { widget_name, parent_class?, path? }",
      gated: true,
      handler: toolCreateWidget,
    },
    ue5_add_widget_to_viewport: {
      name: "ue5_add_widget_to_viewport",
      description: "Add widget to game viewport: { widget_name, z_order? }",
      gated: true,
      handler: toolAddWidgetToViewport,
    },

    // -- Editor --
    ue5_focus_viewport: {
      name: "ue5_focus_viewport",
      description: "Focus viewport on actor or location: { target?, location?, distance?, orientation? }",
      gated: false,
      handler: toolFocusViewport,
    },
    ue5_screenshot: {
      name: "ue5_screenshot",
      description: "Capture viewport screenshot: { filename?, show_ui?, resolution? }",
      gated: false,
      handler: toolScreenshot,
    },

    // -- Input --
    ue5_create_input_mapping: {
      name: "ue5_create_input_mapping",
      description: "Create input mapping: { action_name, key, input_type? }",
      gated: true,
      handler: toolCreateInputMapping,
    },
  };
}

/**
 * Tool instruction block for model injection.
 * Appended to governance preamble when UE5 is available.
 */
export function getToolInstructions() {
  if (!available) return "";

  return `
UE5 Editor (Unreal Engine 5 — live editor connection):
- ue5_check: {} — verify editor connection
- ue5_get_actors: {} — list all actors in level
- ue5_find_actors: { pattern } — find actors by name
- ue5_get_properties: { name } — get actor properties
- ue5_spawn_actor: { name, type, location?, rotation? } — create actor [GATED]
- ue5_delete_actor: { name } — delete actor [GATED]
- ue5_set_transform: { name, location?, rotation?, scale? } — move/rotate/scale [GATED]
- ue5_set_property: { name, property_name, property_value } — set property [GATED]
- ue5_create_blueprint: { name, parent_class? } — create Blueprint [GATED]
- ue5_add_component: { blueprint_name, component_type, component_name } — add component [GATED]
- ue5_compile_blueprint: { blueprint_name } — compile Blueprint [GATED]
- ue5_spawn_blueprint_actor: { blueprint_name, actor_name, location?, rotation? } — spawn from Blueprint [GATED]
- ue5_add_event_node: { blueprint_name, event_type } — add event node [GATED]
- ue5_add_function_node: { blueprint_name, target, function_name } — add function node [GATED]
- ue5_connect_nodes: { blueprint_name, source_node_id, source_pin, target_node_id, target_pin } — wire nodes [GATED]
- ue5_create_widget: { widget_name, parent_class?, path? } — create UMG widget [GATED]
- ue5_screenshot: { filename?, show_ui?, resolution? } — capture viewport`;
}

export default {
  checkAvailability, resetAvailability, getTools, getToolInstructions, sendCommand,
};
