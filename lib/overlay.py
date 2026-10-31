#!/usr/bin/env python3
import json
import math
import os
import socket
import sys
import threading
import time

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
gi.require_version("GtkLayerShell", "0.1")
gi.require_version("PangoCairo", "1.0")
import cairo
from gi.repository import Gdk, GLib, Gtk, GtkLayerShell, Pango, PangoCairo

IDLE_DIM_SECONDS = 6.0
IDLE_REMOVE_SECONDS = 300.0
RIPPLE_SECONDS = 0.55
HIGHLIGHT_SECONDS = 1.1
ARROW = [(0, 0), (0, 21), (5.2, 16.3), (8.6, 24.2), (12.1, 22.7), (8.8, 15.0), (15.6, 15.0)]


def ease_in_out(t):
    return 4 * t * t * t if t < 0.5 else 1 - pow(-2 * t + 2, 3) / 2


def parse_hex(color):
    color = color.lstrip("#")
    return tuple(int(color[i : i + 2], 16) / 255 for i in (0, 2, 4))


class AgentCursor:
    def __init__(self, name, color, x, y):
        self.name = name
        self.color = parse_hex(color)
        self.x = x
        self.y = y
        self.path = None
        self.label = None
        self.ripples = []
        self.highlights = []
        self.last_active = time.monotonic()
        self.typing_until = 0.0

    def travel_to(self, x, y, duration, done):
        start = (self.x, self.y)
        distance = math.hypot(x - start[0], y - start[1])
        if distance < 1:
            done()
            return
        normal = (-(y - start[1]) / distance, (x - start[0]) / distance)
        bow = min(distance * 0.18, 120) * (1 if hash((self.name, round(x), round(y))) % 2 else -1)
        middle = ((start[0] + x) / 2 + normal[0] * bow, (start[1] + y) / 2 + normal[1] * bow)
        self.path = {"start": start, "control": middle, "end": (x, y), "began": time.monotonic(), "duration": duration, "done": done}

    def step(self, now):
        if self.path:
            path = self.path
            t = min(1.0, (now - path["began"]) / path["duration"])
            e = ease_in_out(t)
            (x0, y0), (cx, cy), (x1, y1) = path["start"], path["control"], path["end"]
            self.x = (1 - e) ** 2 * x0 + 2 * (1 - e) * e * cx + e * e * x1
            self.y = (1 - e) ** 2 * y0 + 2 * (1 - e) * e * cy + e * e * y1
            self.last_active = now
            if t >= 1.0:
                self.path = None
                path["done"]()
        self.ripples = [r for r in self.ripples if now - r[2] < RIPPLE_SECONDS]
        self.highlights = [h for h in self.highlights if now - h[1] < HIGHLIGHT_SECONDS]

    def animating(self, now):
        return bool(self.path or self.ripples or self.highlights or now < self.typing_until or now - self.last_active < IDLE_DIM_SECONDS + 1)


class Overlay:
    def __init__(self, socket_path):
        self.socket_path = socket_path
        self.agents = {}
        self.hidden = False
        self.windows = []
        self.ticking = False
        display = Gdk.Display.get_default()
        for index in range(display.get_n_monitors()):
            self.windows.append(self.create_window(display.get_monitor(index)))

    def create_window(self, monitor):
        window = Gtk.Window()
        GtkLayerShell.init_for_window(window)
        GtkLayerShell.set_namespace(window, "hyprhand")
        GtkLayerShell.set_layer(window, GtkLayerShell.Layer.OVERLAY)
        GtkLayerShell.set_monitor(window, monitor)
        GtkLayerShell.set_exclusive_zone(window, -1)
        GtkLayerShell.set_keyboard_mode(window, GtkLayerShell.KeyboardMode.NONE)
        for edge in (GtkLayerShell.Edge.TOP, GtkLayerShell.Edge.BOTTOM, GtkLayerShell.Edge.LEFT, GtkLayerShell.Edge.RIGHT):
            GtkLayerShell.set_anchor(window, edge, True)
        window.set_app_paintable(True)
        visual = window.get_screen().get_rgba_visual()
        if visual:
            window.set_visual(visual)
        area = Gtk.DrawingArea()
        area.connect("draw", self.draw, monitor)
        window.add(area)
        window.connect("realize", lambda w: w.input_shape_combine_region(cairo.Region()))
        window.show_all()
        window.input_shape_combine_region(cairo.Region())
        return window

    def ensure_ticking(self):
        if not self.ticking:
            self.ticking = True
            GLib.timeout_add(16, self.tick)

    def tick(self):
        now = time.monotonic()
        for agent in list(self.agents.values()):
            agent.step(now)
            if now - agent.last_active > IDLE_REMOVE_SECONDS:
                del self.agents[agent.name]
        for window in self.windows:
            window.queue_draw()
        self.ticking = any(agent.animating(now) for agent in self.agents.values())
        return self.ticking

    def draw(self, area, cr, monitor):
        cr.set_operator(cairo.OPERATOR_SOURCE)
        cr.set_source_rgba(0, 0, 0, 0)
        cr.paint()
        cr.set_operator(cairo.OPERATOR_OVER)
        if self.hidden:
            return
        geometry = monitor.get_geometry()
        cr.translate(-geometry.x, -geometry.y)
        now = time.monotonic()
        for agent in self.agents.values():
            idle = now - agent.last_active
            alpha = 1.0 if idle < IDLE_DIM_SECONDS else max(0.35, 1.0 - (idle - IDLE_DIM_SECONDS) / 2)
            for bounds, began in agent.highlights:
                self.draw_highlight(cr, agent, bounds, (now - began) / HIGHLIGHT_SECONDS)
            for x, y, began in agent.ripples:
                self.draw_ripple(cr, agent, x, y, (now - began) / RIPPLE_SECONDS)
            self.draw_cursor(cr, agent, alpha, now)

    def draw_highlight(self, cr, agent, bounds, progress):
        x, y, w, h = bounds
        fade = 1.0 - max(0.0, progress - 0.6) / 0.4
        r, g, b = agent.color
        cr.save()
        cr.new_sub_path()
        radius = min(6, w / 2, h / 2)
        cr.arc(x + w - radius, y + radius, radius, -math.pi / 2, 0)
        cr.arc(x + w - radius, y + h - radius, radius, 0, math.pi / 2)
        cr.arc(x + radius, y + h - radius, radius, math.pi / 2, math.pi)
        cr.arc(x + radius, y + radius, radius, math.pi, 3 * math.pi / 2)
        cr.close_path()
        cr.set_source_rgba(r, g, b, 0.12 * fade)
        cr.fill_preserve()
        cr.set_source_rgba(r, g, b, 0.9 * fade)
        cr.set_line_width(2)
        cr.stroke()
        cr.restore()

    def draw_ripple(self, cr, agent, x, y, progress):
        r, g, b = agent.color
        cr.save()
        cr.arc(x, y, 6 + 26 * ease_in_out(min(progress, 1.0)), 0, 2 * math.pi)
        cr.set_source_rgba(r, g, b, 0.75 * (1 - progress))
        cr.set_line_width(3)
        cr.stroke()
        cr.restore()

    def draw_cursor(self, cr, agent, alpha, now):
        r, g, b = agent.color
        cr.save()
        cr.translate(agent.x, agent.y)
        cr.move_to(*ARROW[0])
        for point in ARROW[1:]:
            cr.line_to(*point)
        cr.close_path()
        cr.set_source_rgba(r, g, b, alpha)
        cr.fill_preserve()
        cr.set_source_rgba(1, 1, 1, alpha)
        cr.set_line_width(1.6)
        cr.set_line_join(cairo.LINE_JOIN_ROUND)
        cr.stroke()
        text = agent.name if not agent.label else f"{agent.name} · {agent.label}"
        if now < agent.typing_until:
            text += " ⌨"
        layout = PangoCairo.create_layout(cr)
        layout.set_font_description(Pango.FontDescription.from_string("Sans Bold 9"))
        layout.set_text(text, -1)
        width, height = layout.get_pixel_size()
        pill_x, pill_y, pad = 16, 20, 6
        cr.new_sub_path()
        radius = (height + 4) / 2
        cr.arc(pill_x + radius, pill_y + radius, radius, math.pi / 2, 3 * math.pi / 2)
        cr.arc(pill_x + width + 2 * pad - radius, pill_y + radius, radius, -math.pi / 2, math.pi / 2)
        cr.close_path()
        cr.set_source_rgba(r, g, b, 0.92 * alpha)
        cr.fill()
        cr.move_to(pill_x + pad, pill_y + 2)
        cr.set_source_rgba(1, 1, 1, alpha)
        PangoCairo.show_layout(cr, layout)
        cr.restore()

    def agent(self, message):
        name = message.get("agent") or "agent"
        agent = self.agents.get(name)
        if not agent:
            start = message.get("from") or message.get("to") or [0, 0]
            agent = AgentCursor(name, message.get("color", "#4299FF"), start[0], start[1])
            self.agents[name] = agent
        agent.last_active = time.monotonic()
        if "label" in message:
            agent.label = message["label"]
        return agent

    def handle(self, message, reply):
        op = message.get("op")
        if op == "ping":
            reply({"ok": True, "agents": [a.name for a in self.agents.values()]})
        elif op == "hide" or op == "show":
            self.hidden = op == "hide"
            for window in self.windows:
                window.queue_draw()
            GLib.timeout_add(70, lambda: reply({"ok": True}) and False)
        elif op == "quit":
            reply({"ok": True})
            GLib.idle_add(Gtk.main_quit)
        elif op == "forget":
            self.agents.pop(message.get("agent"), None)
            self.ensure_ticking()
            reply({"ok": True})
        else:
            agent = self.agent(message)
            if message.get("bounds"):
                agent.highlights.append((message["bounds"], time.monotonic()))
            if op == "type":
                agent.typing_until = time.monotonic() + float(message.get("seconds", 1.2))
            target = message.get("to")

            def arrived():
                if op == "click":
                    agent.ripples.append((agent.x, agent.y, time.monotonic()))
                reply({"ok": True, "at": [round(agent.x), round(agent.y)]})

            if target:
                distance = math.hypot(target[0] - agent.x, target[1] - agent.y)
                duration = float(message.get("travel_ms", min(650, max(180, 140 + distance * 0.3)))) / 1000
                agent.travel_to(target[0], target[1], duration, arrived)
            else:
                arrived()
            self.ensure_ticking()


def serve(overlay, socket_path):
    if os.path.exists(socket_path):
        os.unlink(socket_path)
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(socket_path)
    os.chmod(socket_path, 0o600)
    server.listen(16)

    def client(connection):
        with connection, connection.makefile("rwb") as stream:
            for line in stream:
                done = threading.Event()
                response = {}

                def reply(payload):
                    response.update(payload)
                    done.set()
                    return True

                try:
                    message = json.loads(line)
                except json.JSONDecodeError as error:
                    reply({"ok": False, "error": str(error)})
                else:
                    GLib.idle_add(lambda m=message: overlay.handle(m, reply) and False)
                done.wait(5)
                stream.write((json.dumps(response or {"ok": False, "error": "timeout"}) + "\n").encode())
                stream.flush()

    while True:
        connection, _ = server.accept()
        threading.Thread(target=client, args=(connection,), daemon=True).start()


def main():
    socket_path = sys.argv[1]
    overlay = Overlay(socket_path)
    threading.Thread(target=serve, args=(overlay, socket_path), daemon=True).start()
    try:
        Gtk.main()
    finally:
        if os.path.exists(socket_path):
            os.unlink(socket_path)


if __name__ == "__main__":
    main()
