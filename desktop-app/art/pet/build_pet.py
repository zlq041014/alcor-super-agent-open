"""星引桌宠「小引」：Blender 建模 + 卡通着色 + 像素化，输出精灵表。

用法（项目根目录）：
  D:\\apps\\portable\\blender\\blender.exe -b --factory-startup --python desktop-app/art/pet/build_pet.py
  只重做部分动作：... --python build_pet.py -- --only idle,done
输出：desktop-app/assets/pet/alcor-pet.png、alcor-pet.json；预览数据与对照图在本目录。
"""
import bpy, bmesh, math, os, sys, json, shutil
import numpy as np
from math import sin, cos, pi, radians
from mathutils import Vector, Matrix
from bpy_extras.object_utils import world_to_camera_view

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.normpath(os.path.join(HERE, '..', '..'))
OUT = os.path.join(APP, 'assets', 'pet')
TMP = os.path.join(HERE, '.render')
S, K = 64, 4            # 精灵边长、超采样倍数
ORTHO = S / 20          # 每单位 20 像素
BASE_Z = -0.15          # 身体中心
CS = 0.24               # 伴星缩放
BUBBLE = (43, 2)        # 气泡左上角

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
ONLY = set(argv[argv.index('--only') + 1].split(',')) if '--only' in argv else None

HEX = {
    'ink': '#251b63', 'b0': '#4a3cb8', 'b1': '#6657d9', 'b2': '#8b7cf0', 'b3': '#c3b9ff',
    'aink': '#6e3a08', 'a0': '#d98a12', 'a1': '#f5a524', 'a2': '#ffd977',
    'd0': '#76675a', 'd1': '#a39078', 'd2': '#cdbd9f',
    'eye': '#1b1440', 'white': '#ffffff', 'blush': '#f49ab8', 'paper': '#f6f4ff', 'rule': '#a79ce8',
    'slate': '#8a90a8', 'green': '#17a673', 'red': '#e5484d', 'blue': '#3f73e8', 'violet': '#6657d9',
    'lav': '#c3b9ff', 'mid': '#8b7cf0', 'spark': '#ffd977', 'amber': '#f5a524',
}
CH = {'e': 'eye', 'w': 'white', 'p': 'blush', 'c': 'paper', 'n': 'rule', 'g': 'green', 'r': 'red',
      'b': 'blue', 'a': 'amber', 'v': 'violet', 's': 'slate', 'l': 'lav', 'q': 'mid', 'y': 'spark', 'k': 'ink'}
RENDER_NAMES = ['b0', 'b1', 'b2', 'b3', 'a0', 'a1', 'a2', 'd0', 'd1', 'd2']


def rgb(name):
    h = HEX[name].lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def lin(name):
    return tuple(((c / 255 + 0.055) / 1.055) ** 2.4 if c / 255 > 0.04045 else c / 255 / 12.92 for c in rgb(name)) + (1,)


RC = np.array([rgb(n) for n in RENDER_NAMES], float)

# ---------- 像素图案 ----------
EYES = {
    'open':  ['.ee.', 'ewee', 'eeee', 'eeee', '.ee.'],
    'blink': ['....', '....', 'eeee', '....'],
    'happy': ['....', '.ee.', 'e..e', '....'],
    'sleep': ['....', '....', 'e..e', '.ee.'],
    'focus': ['....', 'ewee', 'eeee', '....'],
    'sad':   ['....', '..ee', '.eee', '.ee.'],
    'wide':  ['.ee.', 'ewwe', 'ewwe', 'eeee', '.ee.'],
}
MOUTH = {
    'smile': ['e..e', '.ee.'],
    'open':  ['eeee', 'eppe', '.ee.'],
    'small': ['.ee.'],
    'o':     ['.ee.', 'e..e', '.ee.'],
    'frown': ['.ee.', 'e..e'],
}
BUBBLE_BASE = ['.ccccccccc.'] + ['ccccccccccc'] * 5 + ['.ccccccccc.', '.cc........', 'c..........']
SYM = {
    '!': ['x', 'x', 'x', '.', 'x'],
    '?': ['.xx.', 'x..x', '..x.', '....', '..x.'],
    'x': ['x...x', '.x.x.', '..x..', '.x.x.', 'x...x'],
    'check': ['....x', '...x.', 'x.x..', '.x...'],
    'hourglass': ['xxxxx', '.x.x.', '..x..', '.xxx.', 'xxxxx'],
}
GLYPH = {
    'card': ['ccccc', 'cnnnc', 'ccccc', 'cnncc', 'ccccc'],
    'z4': ['qqqq', '..q.', '.q..', 'qqqq'],
    'z5': ['qqqqq', '...q.', '..q..', '.q...', 'qqqqq'],
    'spark3': ['.a.', 'awa', '.a.'],
    'spark5': ['..a..', '..a..', 'aawaa', '..a..', '..a..'],
    'speedL': ['qqqq..', '......', '..qqqq', '......', 'qqq...'],
    'speedR': ['..qqqq', '......', 'qqqq..', '......', '...qqq'],
}


def dots(active, on='a', off='s'):
    row = '.'.join((on if j == active or active == 3 else off) * 2 for j in range(3))
    return [row, row]


def wait_dots(k):
    """伴星头顶的等待点：0～3 个白点，描边后在深浅背景上都清楚。"""
    return ['..'.join('w' if j < k else '.' for j in range(3))]


# ---------- 场景 ----------
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = 1
scene.cycles.use_adaptive_sampling = False
scene.cycles.use_denoising = False
scene.cycles.pixel_filter_type = 'BOX'
scene.cycles.filter_width = 0.01
scene.cycles.max_bounces = 0
scene.render.film_transparent = True
scene.render.resolution_x = scene.render.resolution_y = S * K
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
scene.render.image_settings.color_depth = '8'
scene.view_settings.view_transform = 'Standard'
scene.view_settings.look = 'None'
scene.display_settings.display_device = 'sRGB'

cam = bpy.data.objects.new('Camera', bpy.data.cameras.new('Camera'))
cam.data.type = 'ORTHO'
cam.data.ortho_scale = ORTHO
cam.location = (0, -10, 0)
cam.rotation_euler = (pi / 2, 0, 0)
scene.collection.objects.link(cam)
scene.camera = cam

LIGHT = Vector((-0.35, -0.8, 0.5)).normalized()


def toon(name, stops):
    """世界法线 · 光向 → 分段色带 → 自发光；不依赖灯光，颜色直接落在调色板上。"""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    geo = nt.nodes.new('ShaderNodeNewGeometry')
    dot = nt.nodes.new('ShaderNodeVectorMath'); dot.operation = 'DOT_PRODUCT'
    dot.inputs[1].default_value = LIGHT
    ma = nt.nodes.new('ShaderNodeMath'); ma.operation = 'MULTIPLY_ADD'
    ma.inputs[1].default_value = 0.5; ma.inputs[2].default_value = 0.5
    ramp = nt.nodes.new('ShaderNodeValToRGB'); ramp.color_ramp.interpolation = 'CONSTANT'
    els = ramp.color_ramp.elements
    els[0].position, els[0].color = stops[0][0], lin(stops[0][1])
    els[1].position, els[1].color = stops[1][0], lin(stops[1][1])
    for pos, c in stops[2:]:
        els.new(pos).color = lin(c)
    em = nt.nodes.new('ShaderNodeEmission')
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    nt.links.new(geo.outputs['Normal'], dot.inputs[0])
    nt.links.new(dot.outputs['Value'], ma.inputs[0])
    nt.links.new(ma.outputs['Value'], ramp.inputs['Fac'])
    nt.links.new(ramp.outputs['Color'], em.inputs['Color'])
    nt.links.new(em.outputs['Emission'], out.inputs['Surface'])
    return m


MAT_BODY = toon('Body', [(0, 'b0'), (0.40, 'b1'), (0.70, 'b2'), (0.90, 'b3')])
MAT_STAR = toon('Companion', [(0, 'a0'), (0.45, 'a1'), (0.78, 'a2')])
MAT_DIM = toon('CompanionDim', [(0, 'd0'), (0.45, 'd1'), (0.78, 'd2')])

TIP = np.array([0, pi / 2, pi, 1.5 * pi])  # 右、上、左、下


def sphere_mesh(name, u=96, v=48):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=u, v_segments=v, radius=1.0)
    bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(pi / 2, 3, 'X'))
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me); bm.free()
    me.polygons.foreach_set('use_smooth', [True] * len(me.polygons))
    base = np.empty(len(me.vertices) * 3, np.float32)
    me.vertices.foreach_get('co', base)
    return me, base.reshape(-1, 3)


def star(base, r_in, lengths, ks, depth, bend=(0, 0, 0, 0), reach=(1, 1, 1, 1)):
    """单位球 → 软绵四角星。每个角可单独弯曲（度，逆时针为正）和伸缩。"""
    x, y, z = base.T
    rho = np.sqrt(x * x + z * z)
    th = np.arctan2(z, x)
    lobes = [np.clip(np.cos(th - a), 0, None) ** k for a, k in zip(TIP, ks)]
    R = r_in + sum((L - r_in) * lb for L, lb in zip(lengths, lobes))
    px, pz, py = x * R, z * R, y * depth
    ramp = np.clip((rho - 0.25) / 0.65, 0, 1)
    ramp = ramp * ramp * (3 - 2 * ramp)
    for a, lb, b, s in zip(TIP, lobes, bend, reach):
        if b == 0 and s == 1:
            continue
        w = lb * ramp
        cx, cz = 0.3 * cos(a), 0.3 * sin(a)
        dx, dz = (px - cx) * (1 + (s - 1) * w), (pz - cz) * (1 + (s - 1) * w)
        ang = np.radians(b) * w
        c, sn = np.cos(ang), np.sin(ang)
        px, pz = cx + dx * c - dz * sn, cz + dx * sn + dz * c
    return np.stack([px, py, pz], 1).astype(np.float32)


BODY_SHAPE = dict(r_in=0.48, lengths=(0.97, 1.08, 0.97, 0.86), ks=(6, 6, 6, 7), depth=0.48)
TOP_LEAN = 9  # 头顶的角天生向左歪一点

body_me, BODY_BASE = sphere_mesh('XiaoyinBody')
body = bpy.data.objects.new('Xiaoyin', body_me)
body_me.materials.append(MAT_BODY)
scene.collection.objects.link(body)

comp_me, comp_base = sphere_mesh('CompanionStar', 48, 24)
comp_me.vertices.foreach_set('co', star(comp_base, 0.36, (1, 1, 1, 1), (8, 8, 8, 8), 0.45).ravel())
comp_me.materials.append(MAT_STAR)
comp = bpy.data.objects.new('Companion', comp_me)
scene.collection.objects.link(comp)


# ---------- 渲染与像素化 ----------
def render():
    os.makedirs(TMP, exist_ok=True)
    path = os.path.join(TMP, 'pass.png')
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(path, check_existing=False)
    w, h = img.size
    buf = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(buf)
    bpy.data.images.remove(img)
    return (buf.reshape(h, w, 4)[::-1] * 255 + 0.5).astype(np.uint8)


def to_sprite(hi):
    """K×K 块取覆盖率过半者，颜色取块内最多的调色板色。"""
    blk = hi.reshape(S, K, S, K, 4).transpose(0, 2, 1, 3, 4).reshape(S, S, K * K, 4)
    on = blk[..., 3] > 127
    idx = ((blk[..., None, :3].astype(float) - RC) ** 2).sum(-1).argmin(-1)
    counts = np.stack([((idx == c) & on).sum(-1) for c in range(len(RC))], -1)
    out = np.zeros((S, S, 4), np.uint8)
    keep = on.sum(-1) >= K * K // 2
    out[keep, :3] = RC[counts.argmax(-1)[keep]]
    out[keep, 3] = 255
    return out


def outline(layer, name):
    m = layer[..., 3] > 0
    d = np.zeros_like(m)
    d[1:] |= m[:-1]; d[:-1] |= m[1:]; d[:, 1:] |= m[:, :-1]; d[:, :-1] |= m[:, 1:]
    o = d & ~m
    layer[o, :3] = rgb(name); layer[o, 3] = 255


def over(dst, src):
    m = src[..., 3] > 0
    dst[m] = src[m]


def stamp(layer, rows, x, y, flip=False, color=None, clip=None):
    for j, row in enumerate(rows):
        for i, ch in enumerate(row[::-1] if flip else row):
            X, Y = x + i, y + j
            if ch == '.' or not (0 <= X < S and 0 <= Y < S) or (clip is not None and not clip[Y, X]):
                continue
            layer[Y, X, :3] = rgb(color if (color and ch == 'x') else CH.get(ch, 'ink'))
            layer[Y, X, 3] = 255


def project(v):
    u = world_to_camera_view(scene, cam, Vector(v))
    return int(round(u.x * S)), int(round((1 - u.y) * S))


def draw_face(layer, ax, ay, p):
    clip = layer[..., 3] > 0
    e = EYES[p['eyes']]
    lx, ly = p['look']
    ey = ay - len(e) + 1 + ly
    stamp(layer, e, ax - 6 + lx, ey, clip=clip)
    stamp(layer, e, ax + 2 + lx, ey, flip=p['eyes'] == 'sad', clip=clip)
    m = MOUTH[p['mouth']]
    stamp(layer, m, ax - len(m[0]) // 2 + lx, ay + 2 + max(ly, 0), clip=clip)
    if p['blush']:
        stamp(layer, ['pp'], ax - 9 + lx, ay + 1, clip=clip)
        stamp(layer, ['pp'], ax + 7 + lx, ay + 1, clip=clip)


def draw_bubble(layer, sym, color, dy=0):
    bx, by = BUBBLE[0], BUBBLE[1] + dy
    stamp(layer, BUBBLE_BASE, bx, by)
    rows = SYM[sym] if isinstance(sym, str) else sym
    w, h = max(len(r) for r in rows), len(rows)
    stamp(layer, rows, bx + 1 + (9 - w) // 2, by + 1 + (5 - h) // 2, color=color)


# ---------- 姿态 ----------
def P(**kw):
    p = dict(x=0, z=0, tilt=0, sx=1, sz=1, bend=[0, 0, 0, 0], reach=[1, 1, 1, 1], comp=None,
             eyes='open', look=(0, 0), mouth='smile', blush=True, bubble=None, fx=[], fx_plain=[])
    p.update(kw)
    return p


def C(x, y, z, spin=0, s=1, card=False, dim=False):
    return dict(x=x, y=y, z=z, spin=spin, s=s, card=card, dim=dim)


def orbit(phi, r=1.08, depth=0.6, lift=0.05, amp=0.45, **kw):
    return C(r * cos(phi), depth * sin(phi), lift + amp * sin(phi), **kw)


def sway(ph, a=4):
    return [a * sin(ph), 3 * sin(ph + 1), -a * sin(ph), 5 * sin(ph + 2)]


def idle(i, n):
    ph = 2 * pi * i / n
    return P(z=0.07 * sin(2 * ph), bend=sway(2 * ph), comp=orbit(ph),
             eyes='blink' if i == 11 else 'open')


def listen(i, n):
    ph = 2 * pi * i / n
    return P(z=0.04 * sin(ph), tilt=-7, bend=[6, 6, -14 + 4 * sin(ph), 4], mouth='small',
             comp=C(-1.15, -0.3, 0.72 + 0.04 * sin(ph), s=1 + 0.12 * sin(2 * ph)))


def think(i, n):
    ph = 2 * pi * i / n
    return P(z=0.04 * sin(ph), tilt=4, bend=[24, 4 * sin(ph), -6, 4], look=(1, -1), mouth='small',
             comp=C(0.34 * cos(2 * ph), 0.3 * sin(2 * ph), 1.32 + 0.05 * sin(2 * ph), spin=45 * (i % 2)))


def talk(i, n):
    ph = 2 * pi * i / n
    return P(z=0.05 * sin(2 * ph), sz=1 + 0.03 * cos(2 * ph), sx=1 - 0.02 * cos(2 * ph),
             bend=[14 * sin(ph), 3 * sin(ph), -12 * sin(ph + 1), 4],
             mouth='open' if i % 4 < 2 else 'smile', comp=C(1.0, -0.25, 0.6 + 0.05 * sin(ph)))


HOLD = (1.22, -0.25, 0.12)


def queued(i, n):
    ph = 2 * pi * i / n
    c = C(HOLD[0], HOLD[1], HOLD[2] + 0.06 * sin(ph), card=True)
    return P(z=0.04 * sin(ph), bend=[10, 2, -4, 4], look=(1, 0), comp=c,
             fx=[(wait_dots(i % 4), 'comp', -3, -9)])


def handoff(i, n):
    if i < 3:
        k = (i + 1) / 3
        return P(sx=1 + 0.06 * k, sz=1 - 0.07 * k, tilt=-5 * k, bend=[-18 * k, 0, 6 * k, 0],
                 look=(1, 0), comp=C(HOLD[0] - 0.2 * k, HOLD[1], HOLD[2] - 0.05 * k, card=True))
    if i < 6:
        xs = [1.3, 1.75, 2.3][i - 3]
        return P(sx=0.96, sz=1.05, tilt=8, bend=[12, -4, -10, -6], reach=[1.15, 1, 1, 1], look=(1, 0),
                 mouth='open', comp=C(xs, -0.25, 0.1, spin=45 * (i % 2), card=True),
                 fx_plain=[(GLYPH['speedL'], 'comp', -14, -2)] if i > 3 else [])
    k = 1 - (i - 6) / 6
    fx = [(GLYPH['spark5'] if i in (6, 8) else GLYPH['spark3'], 'abs', 57, 26)] if i < 10 else []
    return P(tilt=8 * k * k, bend=[12 * k, 0, -6 * k, 0], reach=[1 + 0.15 * k * k, 1, 1, 1], look=(1, 0),
             fx_plain=fx)


def received(i, n):
    ph = 2 * pi * i / n
    return P(z=0.04 * sin(ph), bend=sway(ph, 3), look=(1, 0), bubble=('hourglass', 'blue', 0 if i < 4 else 1))


def working(i, n):
    ph = 2 * pi * i / n
    return P(z=0.04 * sin(2 * ph), tilt=3, bend=[12 * sin(2 * ph), 0, 12 * sin(2 * ph), 3],
             look=(1, 0), mouth='small', bubble=(dots(i % 4), None, 0))


def unknown(i, n):
    ph = 2 * pi * i / n
    return P(z=0.03 * sin(ph), tilt=7 * sin(ph), bend=[0, 6 * sin(ph), -16, 0], look=(1 if i < 4 else -1, 0),
             mouth='small', bubble=('?', 'amber', round(sin(ph))))


def review(i, n):
    ph = 2 * pi * i / n
    return P(z=0.05 * sin(ph), bend=[18 + 6 * sin(2 * ph), 0, -4, 4],
             comp=C(HOLD[0], HOLD[1], HOLD[2] + 0.06 * sin(ph), card=True), bubble=('!', 'violet', round(sin(ph))))


def done(i, n):
    if i < 4:
        xs = [1.75, 1.45, 1.22, 1.08][i]
        return P(look=(1, 0), comp=C(xs, 0, 0.05, spin=45 * (i % 2), card=True),
                 fx_plain=[(GLYPH['speedR'], 'comp', 6, -2)] if i < 3 else [])
    zs = {4: 0, 5: 0.2, 6: 0.32, 7: 0.22, 8: 0, 9: 0.03, 10: 0, 11: 0}
    sq = {4: (1.08, 0.9), 5: (0.95, 1.07), 6: (0.97, 1.04), 7: (0.98, 1.02), 8: (1.07, 0.92), 9: (0.99, 1.01)}
    sx, sz = sq.get(i, (1, 1))
    up = 26 if 5 <= i <= 8 else 8
    fx = []
    if 5 <= i <= 9:
        fx = [(GLYPH['spark5' if i % 2 else 'spark3'], 'abs', 9, 18), (GLYPH['spark3' if i % 2 else 'spark5'], 'abs', 52, 40),
              (GLYPH['spark3'], 'abs', 14, 46)]
    return P(z=zs[i], sx=sx, sz=sz, bend=[up, 0, -up, -6 if 5 <= i <= 7 else 0],
             eyes='happy' if i >= 5 else 'open', mouth='open' if 5 <= i <= 8 else 'smile',
             comp=C(1.08, 0, 0.05 + zs[i] * 0.6), bubble=('check', 'green', 0) if i >= 5 else None, fx_plain=fx)


def failed(i, n):
    ph = 2 * pi * i / n
    return P(z=-0.06 + 0.02 * sin(ph), sx=1.03, sz=0.94, tilt=-3, bend=[-26, 18, 26, 0], eyes='sad',
             mouth='frown', blush=False, comp=C(0.95, -0.3, -0.48, dim=True, card=True),
             bubble=('x', 'red', 0))


def sleep(i, n):
    ph = 2 * pi * i / n
    fx = []
    for k in (0, 1):
        tt = ((i + 6 * k) % 12) / 12
        fx.append((GLYPH['z4' if tt < 0.5 else 'z5'], 'abs', 40 + int(6 * tt), 22 - int(16 * tt)))
    return P(z=-0.08, sz=1 + 0.03 * sin(ph), sx=1 - 0.015 * sin(ph), bend=[-14, 22, 14, 0], eyes='sleep',
             mouth='small', comp=C(-0.33, -0.1, 1.07 + 0.03 * sin(ph), dim=True), fx_plain=fx)


def drag(i, n):
    ph = 2 * pi * i / n
    return P(z=0.1, sx=0.94, sz=1.08, tilt=7 * sin(ph), bend=[28, 4 * sin(ph), -28, 20 * sin(ph + 1)],
             eyes='wide', mouth='o', comp=orbit(ph, r=0.95, depth=0.5, lift=0.0, amp=0.35))


def poke(i, n):
    zs = [0, 0, 0.12, 0.18, 0.12, 0, 0.02, 0]
    sq = [(1.12, 0.84), (1.06, 0.92), (0.95, 1.08), (0.97, 1.04), (0.98, 1.02), (1.05, 0.95), (1, 1), (1, 1)]
    fx = [(GLYPH['spark5' if i % 2 else 'spark3'], 'abs', 12, 16), (GLYPH['spark3' if i % 2 else 'spark5'], 'abs', 50, 18)] \
        if 2 <= i <= 5 else []
    return P(z=zs[i], sx=sq[i][0], sz=sq[i][1], bend=[20 if 2 <= i <= 4 else 0, 0, -20 if 2 <= i <= 4 else 0, 0],
             eyes='blink' if i < 2 else 'happy', mouth='open' if i < 5 else 'smile',
             comp=orbit(2 * pi * i / n, spin=45 * (i % 2)), fx_plain=fx)


# 名称、帧数、帧率、循环、结束后转入、中文名、触发证据
ANIMS = [
    ('idle', 16, 8, True, None, '待命', '没有需要关注的工作；伴星绕身巡航', idle),
    ('listen', 8, 8, True, None, '聆听', '用户正在总管输入框输入或说话', listen),
    ('think', 12, 10, True, None, '思考', '总管模型请求已发出，尚未收到输出', think),
    ('talk', 8, 10, True, None, '回答', '总管回复正在流式输出', talk),
    ('queued', 8, 8, True, None, '已记下', '交接卡已授权，执行端尚无「已收到」回执；伴星抱着任务卡守在旁边', queued),
    ('handoff', 12, 12, False, 'received', '送出', '执行端「已收到」回执到达时播放一次：伴星带卡飞向电脑', handoff),
    ('received', 8, 6, True, None, '电脑已收到', 'Hub 已登记、仍在排队；没有开始证据，不显示执行中', received),
    ('working', 8, 8, True, None, '执行中', '原执行端确认对应回合已开始', working),
    ('unknown', 8, 6, True, None, '送达待核对', '可能已送出但缺少匹配回执；只核对、不重发', unknown),
    ('review', 8, 6, True, None, '待验收', '回合结束且有结果，等待约定检查或用户核对', review),
    ('done', 12, 10, False, 'idle', '完成', '通过约定检查或用户核对后播放一次：伴星带回结果', done),
    ('failed', 8, 5, True, None, '失败', '原执行端失败回执或核对未通过', failed),
    ('sleep', 12, 4, True, None, '休眠', '无进行中工作且用户长时间未操作', sleep),
    ('drag', 6, 10, True, None, '拖动', '用户正在拖动桌宠；松开回到原状态', drag),
    ('poke', 8, 12, False, None, '戳一下', '单击桌宠；播完回到原状态', poke),
]


def frame_of(p):
    bend = list(p['bend']); bend[1] += TOP_LEAN
    body_me.vertices.foreach_set('co', star(BODY_BASE, bend=bend, reach=p['reach'], **BODY_SHAPE).ravel())
    body_me.update()
    body.location = (p['x'], 0, BASE_Z + p['z'])
    body.rotation_euler = (0, radians(p['tilt']), 0)
    body.scale = (p['sx'], 1, p['sz'])
    c = p['comp']
    if c:
        comp.location = (p['x'] + c['x'], c['y'], BASE_Z + p['z'] + c['z'])
        comp.rotation_euler = (0, radians(c['spin']), 0)
        comp.scale = (CS * c['s'],) * 3
        comp_me.materials[0] = MAT_DIM if c['dim'] else MAT_STAR
    bpy.context.view_layer.update()

    body.hide_render, comp.hide_render = False, True
    B = to_sprite(render())
    outline(B, 'ink')
    ax, ay = project(body.matrix_world @ Vector((0, -0.5, 0.05)))
    draw_face(B, ax, ay, p)

    Cl, cpos = None, None
    if c:
        body.hide_render, comp.hide_render = True, False
        Cl = to_sprite(render())
        cpos = project(comp.location)
        if c['card']:
            stamp(Cl, GLYPH['card'], cpos[0] - 2, cpos[1] + 3)
        outline(Cl, 'aink')

    F = np.zeros((S, S, 4), np.uint8)
    if Cl is not None and c['y'] > 0:
        over(F, Cl)
    over(F, B)
    if Cl is not None and c['y'] <= 0:
        over(F, Cl)

    anchor = {'abs': (0, 0), 'face': (ax, ay), 'comp': cpos or (0, 0)}
    fx = np.zeros_like(F)
    if p['bubble']:
        draw_bubble(fx, *p['bubble'])
    for rows, rel, dx, dy in p['fx']:
        stamp(fx, rows, anchor[rel][0] + dx, anchor[rel][1] + dy)
    outline(fx, 'ink')
    for rows, rel, dx, dy in p['fx_plain']:
        stamp(fx, rows, anchor[rel][0] + dx, anchor[rel][1] + dy)
    over(F, fx)
    return F


def save_png(arr, path):
    h, w, _ = arr.shape
    img = bpy.data.images.new('out', w, h, alpha=True)
    img.pixels.foreach_set((arr[::-1].astype(np.float32) / 255).ravel())
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()
    bpy.data.images.remove(img)


def load_png(path):
    img = bpy.data.images.load(path, check_existing=False)
    w, h = img.size
    buf = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(buf)
    bpy.data.images.remove(img)
    return (buf.reshape(h, w, 4)[::-1] * 255 + 0.5).astype(np.uint8)


def on_checker(img, cell):
    yy, xx = np.mgrid[0:img.shape[0], 0:img.shape[1]]
    bg = np.where(((yy // cell + xx // cell) % 2)[..., None] == 0, 236, 250).astype(np.uint8)
    out = np.dstack([bg, bg, bg, np.full_like(bg, 255)])
    over(out, img)
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    cols = max(a[1] for a in ANIMS)
    sheet_path = os.path.join(OUT, 'alcor-pet.png')
    sheet = np.zeros((S * len(ANIMS), S * cols, 4), np.uint8)
    if ONLY and os.path.exists(sheet_path):
        old = load_png(sheet_path)
        if old.shape == sheet.shape:
            sheet = old
    meta = {'name': '小引', 'frameWidth': S, 'frameHeight': S, 'image': 'alcor-pet.png',
            'displayScale': [2, 3], 'anchor': {'x': S // 2, 'y': 52}, 'animations': {}}
    for row, (name, n, fps, loop, nxt, label, trigger, fn) in enumerate(ANIMS):
        meta['animations'][name] = {'row': row, 'frames': n, 'fps': fps, 'loop': loop, 'next': nxt,
                                    'label': label, 'trigger': trigger}
        if ONLY and name not in ONLY:
            continue
        sheet[row * S:(row + 1) * S] = 0
        for i in range(n):
            sheet[row * S:(row + 1) * S, i * S:(i + 1) * S] = frame_of(fn(i, n))
        strip = np.concatenate([np.pad(sheet[row * S:(row + 1) * S, j * S:min(j + 4, n) * S], ((0, 0), (0, (4 - min(4, n - j)) * S), (0, 0))) for j in range(0, n, 4)], 0)
        os.makedirs(os.path.join(HERE, 'preview'), exist_ok=True)
        save_png(on_checker(strip.repeat(6, 0).repeat(6, 1), 24), os.path.join(HERE, 'preview', name + '.png'))
        print(f'[pet] {name}: {n} frames', flush=True)
    save_png(sheet, sheet_path)
    with open(os.path.join(OUT, 'alcor-pet.json'), 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    with open(os.path.join(HERE, 'preview-data.js'), 'w', encoding='utf-8') as f:
        f.write('window.ALCOR_PET = ' + json.dumps(meta, ensure_ascii=False) + ';\n')

    # 对照图：4 倍最近邻放大，铺棋盘格背景
    z = 4
    big = sheet.repeat(z, 0).repeat(z, 1)
    yy, xx = np.mgrid[0:big.shape[0], 0:big.shape[1]]
    bg = np.where(((yy // 16 + xx // 16) % 2)[..., None] == 0, 236, 250).astype(np.uint8)
    contact = np.dstack([bg, bg, bg, np.full_like(bg, 255)])
    contact[(xx // (S * z) + yy // (S * z)) % 2 == 1, :3] -= 10
    over(contact, big)
    os.makedirs(os.path.join(HERE, 'preview'), exist_ok=True)
    save_png(contact, os.path.join(HERE, 'preview', 'contact-4x.png'))

    frame_of(idle(0, 16))
    comp.location = (1.08, 0, BASE_Z + 0.05)
    comp_me.materials[0] = MAT_STAR
    body.hide_render = comp.hide_render = False
    scene.render.filepath = '//render/'
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, 'alcor-pet.blend'), compress=True)
    shutil.rmtree(TMP, ignore_errors=True)
    print('[pet] done', flush=True)


main()
