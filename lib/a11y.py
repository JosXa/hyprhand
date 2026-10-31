#!/usr/bin/env python3
import json
import sys
import time

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib

try:
    import pyatspi
except ImportError:
    print(json.dumps({"ok": False, "error": "pyatspi is not installed (pacman -S python-atspi at-spi2-core)"}))
    sys.exit(0)

INTERACTIVE_ROLES = {
    "push button", "toggle button", "check box", "radio button", "menu item", "check menu item", "radio menu item",
    "menu", "combo box", "entry", "password text", "text", "spin button", "slider", "scroll bar", "link",
    "page tab", "list item", "tree item", "table cell", "icon", "toggle", "switch", "button", "editbar",
    "terminal", "document web", "tool bar", "table row", "push button menu",
}
PREFERRED_ACTIONS = ["click", "press", "activate", "jump", "toggle", "open", "select", "expand or contract"]
ACTIVATING_ACTIONS = ["click", "press", "activate", "jump", "open"]
SELECTABLE_ROLES = {"list item", "tree item", "table cell", "page tab"}
TEXT_ROLES = {"entry", "password text", "text", "terminal", "editbar", "paragraph"}
NODE_BUDGET = 5000
TIME_BUDGET = 6.0
ELEMENT_LIMIT = 800


def ensure_enabled():
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    current = bus.call_sync("org.a11y.Bus", "/org/a11y/bus", "org.freedesktop.DBus.Properties", "Get",
                            GLib.Variant("(ss)", ("org.a11y.Status", "IsEnabled")), None, 0, 2000, None)
    if current.unpack()[0]:
        return False
    bus.call_sync("org.a11y.Bus", "/org/a11y/bus", "org.freedesktop.DBus.Properties", "Set",
                  GLib.Variant("(ssv)", ("org.a11y.Status", "IsEnabled", GLib.Variant("b", True))), None, 0, 2000, None)
    return True


def safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


def state_names(node):
    states = safe(lambda: node.getState().getStates(), []) or []
    return {str(pyatspi.stateToString(state)) for state in states}


def window_extents(node):
    extents = safe(lambda: node.queryComponent().getExtents(pyatspi.WINDOW_COORDS))
    return [extents.x, extents.y, extents.width, extents.height] if extents else None


def action_names(node):
    action = safe(node.queryAction)
    if not action:
        return []
    return [safe(lambda i=i: action.getName(i), "") for i in range(safe(lambda: action.nActions, 0))]


def text_content(node):
    text = safe(node.queryText)
    if not text:
        return None
    count = safe(lambda: text.characterCount, 0)
    return safe(lambda: text.getText(0, min(count, 400)), None)


def value_of(node):
    value = safe(node.queryValue)
    if not value:
        return None
    return {"current": safe(lambda: value.currentValue), "min": safe(lambda: value.minimumValue), "max": safe(lambda: value.maximumValue)}


def apps_by_pid(pids=None):
    desktop = pyatspi.Registry.getDesktop(0)
    found = []
    for index in range(safe(lambda: desktop.childCount, 0)):
        app = safe(lambda i=index: desktop.getChildAtIndex(i))
        pid = safe(lambda a=app: a.get_process_id()) if app else None
        if app and (pids is None or pid in pids):
            found.append((pid, app))
    return found


def top_levels(app):
    result = []
    for index in range(safe(lambda: app.childCount, 0)):
        node = safe(lambda i=index: app.getChildAtIndex(i))
        if not node:
            continue
        bounds = window_extents(node)
        if not bounds or bounds[2] <= 1 or bounds[3] <= 1:
            continue
        states = state_names(node)
        if states and "showing" not in states and "visible" not in states:
            continue
        result.append((index, node, bounds, states))
    return result


def match_top_level(window, candidates):
    if not candidates:
        return None
    title = window["title"].strip().lower()
    for candidate in candidates:
        if safe(lambda c=candidate: c[1].name, "").strip().lower() == title and title:
            return candidate
    width, height = window["bounds"][2], window["bounds"][3]
    sized = [c for c in candidates if abs(c[2][2] - width) <= 2 and abs(c[2][3] - height) <= 2]
    active = [c for c in sized if "active" in c[3]]
    return (active or sized or [None])[0] if len(candidates) > 1 else candidates[0]


def describe(node, path, origin, root_size, states, role):
    bounds = window_extents(node)
    if not bounds or bounds[2] <= 0 or bounds[3] <= 0:
        return None
    if bounds[0] + bounds[2] <= 0 or bounds[1] + bounds[3] <= 0 or bounds[0] >= root_size[0] or bounds[1] >= root_size[1]:
        return None
    name = (safe(lambda: node.name, "") or "").strip()
    description = (safe(lambda: node.description, "") or "").strip()
    actions = [a for a in action_names(node) if a]
    interesting = role in INTERACTIVE_ROLES or any(a.lower() in PREFERRED_ACTIONS for a in actions) or "focusable" in states
    if not interesting and not name:
        return None
    element = {
        "role": role,
        "name": name,
        "path": path,
        "bounds": [origin[0] + bounds[0], origin[1] + bounds[1], bounds[2], bounds[3]],
        "interactive": bool(interesting),
    }
    if description and description != name:
        element["description"] = description[:200]
    if actions:
        element["actions"] = actions
    flags = sorted(states & {"focused", "checked", "selected", "pressed", "expanded", "editable", "sensitive", "enabled"})
    if flags:
        element["states"] = flags
    if role in TEXT_ROLES or "editable" in states:
        content = text_content(node)
        if content:
            element["text"] = content
    value = value_of(node) if role in {"slider", "spin button", "scroll bar", "progress bar"} else None
    if value:
        element["value"] = value
    return element


def walk_window(window, top_level, deadline):
    index, root, root_bounds, _ = top_level
    origin = window["bounds"][:2]
    root_size = (root_bounds[2], root_bounds[3])
    elements = []
    stack = [(root, [index], 0)]
    visited = 0
    truncated = False
    while stack:
        node, path, depth = stack.pop()
        visited += 1
        if visited > NODE_BUDGET or time.monotonic() > deadline or len(elements) >= ELEMENT_LIMIT:
            truncated = True
            break
        states = state_names(node)
        if depth > 0 and states and ("showing" not in states or "visible" not in states):
            continue
        role = safe(lambda: node.getRoleName(), "") or ""
        if depth > 0:
            element = describe(node, path, origin, root_size, states, role)
            if element:
                element["window"] = window["id"]
                elements.append(element)
        if "manages descendants" in states and safe(lambda: node.childCount, 0) > 200:
            continue
        count = safe(lambda: node.childCount, 0) or 0
        for child_index in range(min(count, 400) - 1, -1, -1):
            child = safe(lambda i=child_index: node.getChildAtIndex(i))
            if child:
                stack.append((child, path + [child_index], depth + 1))
    return elements, truncated


def dump(request):
    enabled_now = ensure_enabled()
    if enabled_now:
        time.sleep(0.6)
    windows = request["windows"]
    pids = {window["pid"] for window in windows}
    deadline = time.monotonic() + request.get("time_budget", TIME_BUDGET)
    apps = {}
    for pid, app in apps_by_pid():
        apps.setdefault(pid, []).append(app)
    sandboxed = [(pid, app) for pid, app_list in apps.items() if pid not in pids for app in app_list]
    result = {"ok": True, "elements": [], "accessible_windows": [], "truncated": False}
    seen = set()
    for window in windows:
        candidates = [(window["pid"], t) for app in apps.get(window["pid"], []) for t in top_levels(app)]
        top_level = match_top_level(window, [t for _, t in candidates])
        app_pid = window["pid"]
        if not top_level:
            title = window["title"].strip().lower()
            titled = [(pid, t) for pid, app in sandboxed for t in top_levels(app) if title and (safe(lambda n=t[1]: n.name, "") or "").strip().lower() == title]
            if len(titled) != 1:
                continue
            app_pid, top_level = titled[0]
        result["accessible_windows"].append(window["id"])
        elements, truncated = walk_window(window, top_level, deadline)
        for element in elements:
            key = (element["role"], element["name"], tuple(element["bounds"]))
            if key not in seen:
                seen.add(key)
                element["pid"] = app_pid
                result["elements"].append(element)
        result["truncated"] = result["truncated"] or truncated
    return result


def resolve(request):
    pid, path = request["pid"], request["path"]
    for app_pid, app in apps_by_pid({pid}):
        node = safe(lambda: app.getChildAtIndex(path[0]))
        for child_index in path[1:]:
            node = safe(lambda n=node, i=child_index: n.getChildAtIndex(i)) if node else None
        if not node:
            continue
        role = safe(lambda: node.getRoleName(), "")
        name = (safe(lambda: node.name, "") or "").strip()
        if role == request.get("role") and name == request.get("name", name):
            return node
    raise LookupError("Element is stale; run observe again")


def act(request):
    node = resolve(request)
    action = safe(node.queryAction)
    names = action_names(node)
    wanted = request.get("action")
    if wanted:
        candidates = [i for i, n in enumerate(names) if n.lower() == wanted.lower()]
    else:
        role = safe(lambda: node.getRoleName(), "")
        preferred = ACTIVATING_ACTIONS if role in SELECTABLE_ROLES else PREFERRED_ACTIONS
        candidates = [names.index(n) for p in preferred for n in names if n.lower() == p][:1]
    if not action or not candidates:
        return {"ok": False, "error": f"No matching accessibility action (available: {names})", "fallback": True}
    done = action.doAction(candidates[0])
    return {"ok": bool(done) or done is None, "action": names[candidates[0]]}


def set_text(request):
    node = resolve(request)
    editable = safe(node.queryEditableText)
    if not editable:
        return {"ok": False, "error": "Element has no editable text interface", "fallback": True}
    if request.get("append"):
        length = safe(lambda: node.queryText().characterCount, 0)
        done = editable.insertText(length, request["text"], len(request["text"]))
    else:
        done = editable.setTextContents(request["text"])
    if not done:
        return {"ok": False, "error": "Application refused the text change", "fallback": True}
    return {"ok": True, "text": text_content(node)}


def set_value(request):
    node = resolve(request)
    value = safe(node.queryValue)
    if not value:
        return {"ok": False, "error": "Element has no value interface"}
    value.currentValue = float(request["value"])
    return {"ok": True, "value": value_of(node)}


def focus(request):
    node = resolve(request)
    component = safe(node.queryComponent)
    done = safe(component.grabFocus, False) if component else False
    return {"ok": bool(done), "error": None if done else "Application refused focus", "fallback": not done}


def read(request):
    node = resolve(request)
    return {"ok": True, "text": text_content(node), "states": sorted(state_names(node)), "value": value_of(node)}


COMMANDS = {"dump": dump, "act": act, "set-text": set_text, "set-value": set_value, "focus": focus, "read": read}


def main():
    request = json.loads(sys.stdin.read() or "{}")
    try:
        result = COMMANDS[sys.argv[1]](request)
    except LookupError as error:
        result = {"ok": False, "error": str(error), "stale": True}
    except Exception as error:
        result = {"ok": False, "error": f"{type(error).__name__}: {error}"}
    print(json.dumps(result))


if __name__ == "__main__":
    main()
