#!/usr/bin/env python3
"""Read-only Digital topology analysis, not a Bread circuit generator.

Shape formulas are independently implemented from pinned Digital 9cf6e107
and cross-checked against the original CPU.svg. Endpoint-only wire joining
matches WireNetList/Net. Splitter relationships remain explicit, never
collapsed into a same-width electrical net.
"""
from pathlib import Path
from collections import Counter, defaultdict
import argparse, hashlib, json, re, subprocess
import xml.etree.ElementTree as ET

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
SOURCE = args.source.resolve()
DEST = args.output.resolve()
DEST.mkdir(parents=True, exist_ok=True)
CPU_COMMIT = '966772fbf4c0cb43c86e0b5850a65205526c121d'
DIGITAL_COMMIT = '9cf6e1077ec9d2e6618101f3d4ff9a6501b3cf60'
if subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=SOURCE, text=True).strip() != CPU_COMMIT:
    raise ValueError('Use the pinned original CPU commit')
if subprocess.check_output(['git', 'status', '--porcelain', '--', 'custom_components'], cwd=SOURCE, text=True).strip():
    raise ValueError('Original Digital circuits have uncommitted changes; preserve them and use an isolated pinned checkout')

class Union:
    def __init__(self): self.parents = {}
    def find(self, p):
        self.parents.setdefault(p,p)
        if self.parents[p] != p: self.parents[p] = self.find(self.parents[p])
        return self.parents[p]
    def join(self, p,q): self.parents[self.find(p)] = self.find(q)

def attributes(node, root):
    vals = {}
    for ent in node.findall('elementAttributes/entry'):
        key, value = ent
        if value.tag == 'rotation':
            actual = value
            if 'reference' in value.attrib:
                match = re.search(r'visualElement\[(\d+)\]', value.attrib['reference'])
                if not match: raise ValueError(value.attrib)
                actual = root.findall('visualElements/visualElement')[int(match[1])-1].find('elementAttributes/entry/rotation')
            val = int(actual.attrib['rotation'])
        elif value.tag in ('int','long'): val = int(value.text)
        elif value.tag == 'boolean': val = value.text == 'true'
        elif value.tag == 'data': val = ''.join(value.itertext()).strip()
        else: val = value.text
        vals[key.text] = val
    return vals

def spec(label,direction,width=1,local=(0,0),**extra):
    return dict(label=label,direction=direction,width=width,local_position=list(local),**extra)

def generic(inputs,outputs,width=3,invert=False):
    symmetric = len(outputs) == 1
    ports=[]
    for i,(label,bits) in enumerate(inputs):
        gap=20 if symmetric and len(inputs)%2==0 and i>=len(inputs)//2 else 0
        ports.append(spec(label,'in',bits,(0,i*20+gap)))
    offset=len(inputs)//2*20 if symmetric else 0
    for i,(label,bits) in enumerate(outputs):
        ports.append(spec(label,'out',bits,(20*(width+int(invert)),i*20+offset)))
    return ports

raw={}
for path in sorted((SOURCE/'custom_components').glob('*')):
    if path.suffix not in ('.dig','.dist'): continue
    r=ET.parse(path).getroot()
    name=path.name.removesuffix('.dist')
    text=path.read_text(); line_numbers=[]
    for line_no,line in enumerate(text.splitlines(),1):
        if line.strip()=='<visualElement>': line_numbers.append(line_no)
    elements=[]
    for i,e in enumerate(r.findall('visualElements/visualElement')):
        elements.append(dict(index=i,type=e.findtext('elementName'),attributes=attributes(e,r),position=[int(e.find('pos').attrib[k]) for k in ('x','y')],source_line=line_numbers[i]))
    interface=[]
    # Circuit.getInputNames/getOutputNames preserves visual-element order.
    for direction,names in [('in',('In','Clock')),('out',('Out',))]:
        for e in elements:
            if e['type'] in names:
                interface.append(dict(label=e['attributes'].get('Label',e['type']),direction=direction,width=e['attributes'].get('Bits',1),element_index=e['index']))
    wires=[]
    for i,w in enumerate(r.findall('wires/wire')):
        wires.append(dict(index=i,p1=[int(w.find('p1').attrib[k]) for k in ('x','y')],p2=[int(w.find('p2').attrib[k]) for k in ('x','y')]))
    raw[name]=dict(file=str(path.relative_to(SOURCE)),sha256=hashlib.sha256(path.read_bytes()).hexdigest(),elements=elements,wires=wires,interface=interface)

def shape(e):
    t=e['type'];a=e['attributes'];bits=a.get('Bits',1)
    if t in raw:
        ins=[(p['label'],p['width']) for p in raw[t]['interface'] if p['direction']=='in']
        outs=[(p['label'],p['width']) for p in raw[t]['interface'] if p['direction']=='out']
        return generic(ins,outs)
    if t=='Text': return []
    if t in ('In','Clock','Ground','VDD','Button'): return [spec('out','out',bits)]
    if t in ('Out','LED'): return [spec('in','in',bits)]
    if t=='Tunnel': return [spec(a['NetName'].strip(),'tunnel',None)]
    if t in ('And','Or','XOr','NOr','NAnd'):
        n=a.get('Inputs',2);return generic([(f'in{i+1}',bits) for i in range(n)],[('out',bits)],4 if a.get('wideShape') else 3,t in ('NOr','NAnd'))
    if t=='Not': return generic([('in',bits)],[('out',bits)],1,True)
    if t=='D_FF': return generic([('D',bits),('C',1)],[('Q',bits),('~Q',bits)])
    if t=='JK_FF': return generic([('J',bits),('C',1),('K',bits)],[('Q',bits),('~Q',bits)])
    if t=='Register': return generic([('D',bits),('C',1),('en',1)],[('Q',bits)])
    if t=='Counter': return generic([('en',1),('C',1),('clr',1)],[('out',bits),('ovf',1)])
    if t=='CounterPreset': return generic([('en',1),('C',1),('dir',1),('in',bits),('ld',1),('clr',1)],[('out',bits),('ovf',1)])
    if t=='ROM': return generic([('A',a.get('AddrBits',8)),('sel',1)],[('D',bits)])
    if t in ('Add','Sub'): return generic([('a',bits),('b',bits),('c_i',1)],[('s',bits),('c_o',1)])
    if t=='Comparator': return generic([('a',bits),('b',bits)],[('>',1),('=',1),('<',1)])
    if t=='Driver': return [spec('in','in',bits,(-20,0)),spec('sel','in',1,(0,20 if a.get('flipSelPos') else -20)),spec('out','out',bits,(20,0))]
    if t=='Multiplexer':
        sb=a.get('Selector Bits',1);n=2**sb
        out=[spec('sel','in',sb,(20,0 if a.get('flipSelPos') else n*20))]
        out += [spec(f'in{i}','in',bits,(0,i*40 if n==2 else i*20)) for i in range(n)]
        out += [spec('out','out',bits,(40,n//2*20))]
        return out
    if t=='Demultiplexer':
        sb=a.get('Selector Bits',1);n=2**sb
        out=[spec('sel','in',sb,(20,0 if a.get('flipSelPos') else n*20)),spec('in','in',bits,(0,n//2*20))]
        out += [spec(f'out{i}','out',bits,(40,i*40 if n==2 else i*20)) for i in range(n)]
        return out
    if t=='Splitter':
        ps=[]
        # Digital Keys defaults: INPUT_SPLIT="4,4", OUTPUT_SPLIT="8".
        for direction,x,key in [('in',0,'Input Splitting'),('out',20,'Output Splitting')]:
            start=0
            for i,n in enumerate(map(int,a.get(key,'4,4' if direction=='in' else '8').split(','))):
                label=str(start) if n==1 else f'{start}-{start+n-1}'
                ps.append(spec(label,direction,n,(x,i*20*a.get('splitterSpreading',1)),bit_start=start)); start+=n
        return ps
    if t=='Seven-Seg':
        return [spec(chr(65+i) if i<7 else 'DP','in',1,((i%4)*20,(i//4)*140)) for i in range(8)]
    raise ValueError(t)

def global_pos(local,e):
    x,y=local
    if e['attributes'].get('mirror'): y=-y
    rot=e['attributes'].get('rotation',0)
    x,y=[(x,y),(y,-x),(-x,-y),(-y,x)][rot]
    return [x+e['position'][0],y+e['position'][1]]

for name,m in raw.items():
    union=Union()
    for w in m['wires']: union.join(tuple(w['p1']),tuple(w['p2']))
    tunnels=defaultdict(list)
    for e in m['elements']:
        e['pins']=shape(e)
        for p in e['pins']:
            p['position']=global_pos(p['local_position'],e)
            union.find(tuple(p['position']))
        if e['type']=='Tunnel': tunnels[e['attributes']['NetName'].strip()].append(tuple(e['position']))
    for positions in tunnels.values():
        for p in positions[1:]: union.join(positions[0],p)
    roots=defaultdict(list)
    for p in union.parents: roots[union.find(p)].append(list(p))
    nets=[]
    root_net={}
    for i,(r,pts) in enumerate(roots.items()):
        labels=[label for label,positions in tunnels.items() if union.find(positions[0])==r]
        netid=f'n{i:03}'
        root_net[r]=netid
        nets.append(dict(id=netid,names=labels,points=pts,endpoints=[]))
    netbyid={n['id']:n for n in nets}
    for e in m['elements']:
        for p in e['pins']:
            netid=root_net[union.find(tuple(p['position']))];p['net']=netid
            netbyid[netid]['endpoints'].append(dict(element_index=e['index'],type=e['type'],instance_label=e['attributes'].get('Label'),pin=p['label'],direction=p['direction'],width=p['width']))
    m['nets']=nets
    m['element_counts']=dict(Counter(e['type'] for e in m['elements']))
    m['pin_count']=sum(len(e['pins']) for e in m['elements'])
    m['net_count']=len(nets)
    m['width_conflicts']=[]
    m['unwired_pins']=[]
    for n in nets:
        widths=set(p['width'] for p in n['endpoints'] if p['width'] is not None)
        if len(widths)>1: m['width_conflicts'].append(n)
        for endpoint in n['endpoints']:
            if len(n['endpoints'])==1 and len(n['points'])==1:
                m['unwired_pins'].append(endpoint)

report=dict(source_commit=CPU_COMMIT,digital_semantics_reference_commit=DIGITAL_COMMIT,
            provenance='Read-only XML topology extraction; NOT an editor-built circuit or generated Bread netlist',
            connectivity='Only equal saved wire endpoint positions; equal local trimmed tunnel names merged. Splitter bit relationships explicit.',
            custom_port_order='XML visualElement ordering; input elements In/Clock, output elements Out',modules=raw)
(DEST/'digital-topology.json').write_text(json.dumps(report,indent=2)+'\n')
summary=[]
for name,m in raw.items():
    summary.append(dict(module=name,file=m['file'],elements=len(m['elements']),wires=len(m['wires']),pins=m['pin_count'],nets=m['net_count'],width_conflicts=len(m['width_conflicts']),unwired_pins=len(m['unwired_pins']),interface=m['interface']))
(DEST/'inventory.json').write_text(json.dumps(summary,indent=2)+'\n')
print(f'Extracted {len(raw)} Digital modules into {DEST}')
