#!/usr/bin/env python3
"""Convert Bryan's pinned Digital CPU into a self-contained Bread circuit.

Input is the source topology from extract_topology.py. Splitters become
scalar net aliases; original hierarchy stays visible. Digital's larger
leaves become inspectable composites of existing Bread primitives. Writes
only to the explicitly selected output directory. This is a generated port,
not manual editor construction.
"""
from pathlib import Path
from collections import defaultdict
import argparse, hashlib, json, re, subprocess

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source',type=Path,required=True)
parser.add_argument('--topology',type=Path,required=True)
parser.add_argument('--output',type=Path,required=True,help='Directory for the bundled circuit JSON')
parser.add_argument('--program',type=Path,help='Optional boot ROM v2.0 raw image (default: original callret)')
args=parser.parse_args()
SOURCE=args.source.resolve()
TOPOLOGY_PATH=args.topology.resolve()
TOPOLOGY=json.loads(TOPOLOGY_PATH.read_text())
if TOPOLOGY['source_commit']!='966772fbf4c0cb43c86e0b5850a65205526c121d' or subprocess.check_output(['git','rev-parse','HEAD'],cwd=SOURCE,text=True).strip()!=TOPOLOGY['source_commit']:
    raise ValueError('Use the pinned original CPU commit and topology')
if subprocess.check_output(['git','status','--porcelain','--','custom_components','microcode/rom.hex','assembler/prog.hex'],cwd=SOURCE,text=True).strip():
    raise ValueError('Source circuit/ROM files have uncommitted changes; preserve them and use an isolated pinned checkout')
for module in TOPOLOGY['modules'].values():
    file=SOURCE/'custom_components'/Path(module['file']).name
    if hashlib.sha256(file.read_bytes()).hexdigest()!=module['sha256']:
        raise ValueError('Source/topology file checksum mismatch: '+str(file))
MODULES=TOPOLOGY['modules']
OUT=args.output.resolve()
OUT.mkdir(parents=True,exist_ok=True)
DEFS={}
CONTROL_LABELS=['PCOut','PCEnable','PCClear','PCLd','ALUOut','LdOut','LdA','EnA','LdB','EnB','Sub','LdInst','EnInst','LdMAddr','MWr','MEn','Hlt','LdFlags','EnGnd','RstDone','MPCRst','PCLdIfEq','PCLdIfGorEq','PCLdIfZero','StkEn','StkLd','StkInc','StkDec','StkRst']

def type_name(module):
    return 'user.Digital_'+module.removesuffix('.dig')

def port_name(label,width=1,bit=0):
    replacements={'~Q':'Qn','>':'GT','=':'EQ','<':'LT'}
    name=replacements.get(label,label)
    name=re.sub('[^A-Za-z0-9_]','_',name)
    if not name or not re.match('[A-Za-z_]',name): name='P'+name
    return name if width==1 else f'{name}_{bit}'

class Union:
    def __init__(self):self.parent={}
    def find(self,x):
        self.parent.setdefault(x,x)
        if self.parent[x]!=x:self.parent[x]=self.find(self.parent[x])
        return self.parent[x]
    def join(self,x,y):self.parent[self.find(y)]=self.find(x)

class Build:
    def __init__(self,name,description):
        self.obj=dict(version=1,kind='composite',name=name,description=description,components=[],nets=[],ports=[],metadata=dict(provenance='generated Digital source port / NOT manually editor-built'))
        self.net=defaultdict(list);self.consts={}
    def comp(self,type,id,params=None,label=None):
        i=len(self.obj['components']);e=dict(id=id,type=type,position=[(i%5)*180,(i//5)*100])
        if params is not None:e['params']=params
        if label is not None:e['label']=label
        self.obj['components'].append(e);return id
    def wire(self,net,*endpoints):
        self.net[net].extend(e for e in endpoints if e not in self.net[net])
        return net
    def port(self,label,dir,net):
        self.obj['ports'].append(dict(name=label,dir=dir,internalNet=net));return net
    def const(self,value):
        if value not in self.consts:
            id=f'const{value}';self.comp('prim.CONST_'+str(value),id);self.wire(f'const{value}',id+'.Y');self.consts[value]=f'const{value}'
        return self.consts[value]
    def gate(self,type,id,inputs,out=None):
        self.comp('prim.'+type,id,None if type in ('NOT','BUF') else {'inputs':len(inputs)})
        for i,n in enumerate(inputs):self.wire(n,id+'.'+chr(65+i))
        return self.wire(out or id,id+'.Y')
    def mux(self,id,a,b,sel):
        self.comp('prim.MUX2',id,{'width':len(a)})
        for i,n in enumerate(a):self.wire(n,f'{id}.A{i}')
        for i,n in enumerate(b):self.wire(n,f'{id}.B{i}')
        self.wire(sel,id+'.S')
        return [self.wire(f'{id}_{i}',f'{id}.Y{i}') for i in range(len(a))]
    def adder(self,id,a,b,cin):
        self.comp('prim.ADDER',id,{'width':len(a)})
        for i,n in enumerate(a):self.wire(n,f'{id}.A{i}')
        for i,n in enumerate(b):self.wire(n,f'{id}.B{i}')
        self.wire(cin,id+'.Cin')
        return [self.wire(f'{id}_{i}',f'{id}.S{i}') for i in range(len(a))],self.wire(id+'_carry',id+'.Cout')
    def bankports(self,label,dir,width):
        return [self.port(port_name(label,width,i),dir,f'{label}_{i}') for i in range(width)]
    def finish(self):
        self.obj['nets']=[dict(id=n,name=n,endpoints=eps) for n,eps in self.net.items() if eps]
        missing=set(p['internalNet'] for p in self.obj['ports'])-set(n['id'] for n in self.obj['nets'])
        if missing:raise ValueError((self.obj['name'],'ports without component endpoints',missing))
        return self.obj

def helper(kind,width=1,selector=1):
    typename=f'user.DigitalLeaf_{kind}_{width}'+(f'_{selector}' if kind in ('Mux','Demux') else '')
    if typename in DEFS:return typename
    b=Build(typename,f'Generated visible {kind} equivalent, width {width}; source Digital semantics. NOT manually authored.')
    if kind=='Driver':
        data=b.bankports('in','in',width);sel=b.port('sel','in','sel');out=b.bankports('out','out',width)
        for i in range(width):
            id=f'buffer{i}';b.comp('prim.TRISTATE',id);b.wire(data[i],id+'.A');b.wire(sel,id+'.OE');b.wire(out[i],id+'.Y')
    elif kind=='Register':
        data=b.bankports('D','in',width);clock=b.port('C','in','clock');en=b.port('en','in','enable');q=b.bankports('Q','out',width)
        d=b.mux('load_mux',q,data,en)
        for i in range(width):
            id=f'bit{i}';b.comp('prim.DFF',id,{'initialQ':0});b.wire(d[i],id+'.D');b.wire(clock,id+'.CLK');b.wire(q[i],id+'.Q');b.wire(f'qnot{i}',id+'.Qn')
    elif kind in ('Counter','CounterPreset'):
        en=b.port('en','in','en');clock=b.port('C','in','clock')
        direction=b.port('dir','in','dir') if kind=='CounterPreset' else b.const(0)
        data=b.bankports('in','in',width) if kind=='CounterPreset' else None
        ld=b.port('ld','in','ld') if kind=='CounterPreset' else None
        clear=b.port('clr','in','clear');q=b.bankports('out','out',width);ovf=b.port('ovf','out','ovf')
        zero=b.const(0);one=b.const(1)
        plus,_=b.adder('increment',q,[zero]*width,one)
        if kind=='CounterPreset':
            minus,_=b.adder('decrement',q,[one]*width,zero)
            counted=b.mux('direction_mux',plus,minus,direction)
        else:counted=plus
        enabled=b.mux('enable_mux',q,counted,en)
        loaded=b.mux('load_mux',enabled,data,ld) if kind=='CounterPreset' else enabled
        d=b.mux('clear_mux',loaded,[zero]*width,clear)
        for i in range(width):
            id=f'bit{i}';b.comp('prim.DFF',id,{'initialQ':0});b.wire(d[i],id+'.D');b.wire(clock,id+'.CLK');b.wire(q[i],id+'.Q');b.wire(f'qnot{i}',id+'.Qn')
        maximum=b.gate('AND','maximum',q)
        terminal=maximum
        if kind=='CounterPreset':
            notq=[b.gate('NOT',f'notq{i}',[q[i]]) for i in range(width)]
            minimum=b.gate('AND','minimum',notq)
            terminal=b.mux('terminal_mux',[maximum],[minimum],direction)[0]
        b.gate('AND','overflow',[en,terminal],ovf)
    elif kind in ('Add','Sub'):
        a=b.bankports('a','in',width);data=b.bankports('b','in',width);cin=b.port('c_i','in','cin');s=b.bankports('s','out',width);carry=b.port('c_o','out','carry')
        if kind=='Sub':
            data=[b.gate('NOT',f'not_b{i}',[n]) for i,n in enumerate(data)];cin=b.gate('NOT','not_borrow',[cin])
        sums,co=b.adder('arithmetic',a,data,cin)
        for i in range(width):b.gate('BUF',f'sum_out{i}',[sums[i]],s[i])
        b.gate('NOT' if kind=='Sub' else 'BUF','carry_out',[co],carry)
    elif kind=='Comparator':
        a=b.bankports('a','in',width);data=b.bankports('b','in',width)
        gt=b.port('GT','out','gt');eq=b.port('EQ','out','eq');lt=b.port('LT','out','lt')
        prefix=b.const(1);prevgt=b.const(0);prevlt=b.const(0)
        for i in reversed(range(width)):
            na=b.gate('NOT',f'nota{i}',[a[i]]);nb=b.gate('NOT',f'notb{i}',[data[i]])
            equal=b.gate('XNOR',f'equal{i}',[a[i],data[i]])
            g=b.gate('AND',f'greater{i}',[prefix,a[i],nb]);l=b.gate('AND',f'less{i}',[prefix,na,data[i]])
            prevgt=b.gate('OR',f'gt_prefix{i}',[prevgt,g]);prevlt=b.gate('OR',f'lt_prefix{i}',[prevlt,l]);prefix=b.gate('AND',f'eq_prefix{i}',[prefix,equal])
        b.gate('BUF','greater_out',[prevgt],gt);b.gate('BUF','equal_out',[prefix],eq);b.gate('BUF','less_out',[prevlt],lt)
    elif kind=='Mux':
        select=b.bankports('sel','in',selector)
        inputs=[b.bankports(f'in{i}','in',width) for i in range(2**selector)]
        for stage in range(selector):inputs=[b.mux(f'mux_{stage}_{i//2}',inputs[i],inputs[i+1],select[stage]) for i in range(0,len(inputs),2)]
        out=b.bankports('out','out',width)
        for i in range(width):b.gate('BUF',f'output{i}',[inputs[0][i]],out[i])
    elif kind=='Demux':
        select=b.bankports('sel','in',selector);data=b.bankports('in','in',width)
        inverted=[b.gate('NOT',f'not_sel{i}',[n]) for i,n in enumerate(select)]
        for route in range(2**selector):
            active=b.gate('AND',f'decode{route}',[select[i] if (route>>i)&1 else inverted[i] for i in range(selector)])
            out=b.bankports(f'out{route}','out',width)
            for bit in range(width):b.gate('AND',f'route{route}_{bit}',[active,data[bit]],out[bit])
    else:raise ValueError(kind)
    DEFS[typename]=b.finish();return typename

def scalar_nets(module):
    u=Union()
    for net in module['nets']:
        ws=[p['width'] for p in net['endpoints'] if p['width'] is not None]
        if len(set(ws))>1:raise ValueError('Conflicting bus widths: '+net['id'])
        width=max(ws or [1])
        for bit in range(width):u.find((net['id'],bit))
    for e in module['elements']:
        if e['type']!='Splitter':continue
        ins=[p for p in e['pins'] if p['direction']=='in'];outs=[p for p in e['pins'] if p['direction']=='out']
        for p in ins:
            for q in outs:
                for sourcebit in range(max(p['bit_start'],q['bit_start']),min(p['bit_start']+p['width'],q['bit_start']+q['width'])):
                    u.join((p['net'],sourcebit-p['bit_start']),(q['net'],sourcebit-q['bit_start']))
    groups=defaultdict(list)
    for lane in u.parent:groups[u.find(lane)].append(lane)
    names={};groups_out=[]
    for i,lanes in enumerate(groups.values()):
        id=f'lane{i:04}'
        for lane in lanes:names[lane]=id
        groups_out.append(dict(id=id,source_lanes=[dict(net=n,bit=k) for n,k in lanes]))
    return names,groups_out

def lower(name,root=False,program=None):
    m=MODULES[name];lane,groups=scalar_nets(m);b=Build(type_name(name),'Generated source-faithful Digital topology port. NOT manually editor-built.')
    pinmap=[]
    interfaces={(p['element_index'],p['direction']):p for p in m['interface']}
    for e in m['elements']:
        t=e['type'];a=e['attributes'];width=a.get('Bits',1);id=f'v{e["index"]}';mapping={}
        if t in ('Tunnel','Splitter','Text'):continue
        if not root and t in ('In','Clock','Out'):
            direction='out' if t=='Out' else 'in';p=interfaces[(e['index'],direction)]
            net=e['pins'][0]['net']
            for bit in range(p['width']):b.port(port_name(p['label'],p['width'],bit),direction,lane[(net,bit)])
            continue
        if t in MODULES:
            typ=type_name(t)
            if typ not in DEFS:DEFS[typ]=lower(t)
            b.comp(typ,id,label=a.get('Label',t.removesuffix('.dig')))
            for p in e['pins']:
                for bit in range(p['width']):mapping[(p['label'],bit)]=[f'{id}.{port_name(p["label"],p["width"],bit)}']
        elif t in ('Counter','CounterPreset','Register','Add','Sub','Comparator','Multiplexer','Demultiplexer','Driver'):
            kind={'Multiplexer':'Mux','Demultiplexer':'Demux'}.get(t,t);typ=helper(kind,width,a.get('Selector Bits',1));b.comp(typ,id,label=a.get('Label',t))
            for p in e['pins']:
                for bit in range(p['width']):mapping[(p['label'],bit)]=[f'{id}.{port_name(p["label"],p["width"],bit)}']
        elif t=='ROM':
            contents=a.get('Data','')
            file=None
            if name=='control_logic.dig' and e['index']==0:file=SOURCE/'microcode/rom.hex';contents=file.read_text()
            if root and e['index']==82:
                file=Path(program) if program else SOURCE/'assembler/prog.hex';contents=file.read_text()
            params=dict(addressBits=a['AddrBits'],dataBits=width,contents=contents)
            if width==29:params['bitLabels']=CONTROL_LABELS
            b.comp('mem.ROM',id,params,a.get('Label','Microcode ROM' if width==29 else 'ROM'))
            for p in e['pins']:
                for bit in range(p['width']):mapping[(p['label'],bit)]=[f'{id}.'+('SEL' if p['label']=='sel' else f'{p["label"]}{bit}')]
            if file:pinmap.append(dict(element=e['index'],rom_file=str(file.relative_to(SOURCE)) if file.is_relative_to(SOURCE) else file.name,rom_sha256=hashlib.sha256(file.read_bytes()).hexdigest(),inline_data_original=a.get('Data'),selected='external ROM file'))
        elif t in ('And','Or','XOr','NOr','NAnd','Not','D_FF'):
            typ={'And':'prim.AND','Or':'prim.OR','XOr':'prim.XOR','NOr':'prim.NOR','NAnd':'prim.NAND','Not':'prim.NOT','D_FF':'prim.DFF'}[t]
            if width!=1:raise ValueError('Non-scalar logic gate is not in source CPU')
            params={'initialQ':0} if t=='D_FF' else None if t=='Not' else {'inputs':len([p for p in e['pins'] if p['direction']=='in'])}
            b.comp(typ,id,params,a.get('Label'))
            for p in e['pins']:
                label=p['label'];out={'D':'D','C':'CLK','Q':'Q','~Q':'Qn'}[label] if t=='D_FF' else 'Y' if p['direction']=='out' else 'A' if t=='Not' else chr(64+int(label.removeprefix('in')))
                mapping[(label,0)]=[f'{id}.{out}']
        elif t in ('Ground','VDD','Clock','In','Button','Out','LED','Seven-Seg'):
            if t=='Seven-Seg':
                b.comp('io.7seg',id,label=a.get('Label'))
                for p in e['pins']:mapping[(p['label'],0)]=[f'{id}.{p["label"].lower()}']
            else:
                for bit in range(width):
                    bid=id if width==1 else f'{id}_b{bit}'
                    typ='prim.CONST_0' if t=='Ground' else 'prim.CONST_1' if t=='VDD' else 'gen.clock' if t=='Clock' else 'io.led' if t in ('Out','LED') else 'io.switch'
                    params={'freqHz':a.get('Frequency',50)} if typ=='gen.clock' else None
                    label=a.get('Label',f'{t} {e["index"]}')+(f' bit {bit}' if width>1 else '')
                    b.comp(typ,bid,params,label)
                    for p in e['pins']:mapping[(p['label'],bit)]=[f'{bid}.'+('A' if typ=='io.led' else 'Y')]
        else:raise ValueError(t)
        # Original coordinates are retained for source composites and root
        # symbols; scalarized interactive bus inputs receive separate offsets.
        for c in b.obj['components']:
            if c['id']==id or c['id'].startswith(id+'_b'):
                bit=int(c['id'].split('_b')[-1]) if '_b' in c['id'] else 0
                c['position']=[e['position'][0]+bit*70,e['position'][1]]
                if a.get('rotation'):c['rotation']=a['rotation']*90
        for p in e['pins']:
            for bit in range(p['width']):
                eps=mapping[(p['label'],bit)];b.wire(lane[(p['net'],bit)],*eps)
                pinmap.append(dict(element=e['index'],source_type=t,source_pin=p['label'],source_bit=bit,source_net=p['net'],bread_net=lane[(p['net'],bit)],bread_endpoints=eps))
    result=b.finish()
    result['metadata'].update(dict(source_repository='https://github.com/ehrlich-b/8bitcpu',source_commit=TOPOLOGY['source_commit'],source_file=m['file'],source_sha256=m['sha256'],digital_reference_commit=TOPOLOGY['digital_semantics_reference_commit'],source_port_order=m['interface'],pin_map=pinmap,scalar_net_aliases=groups,generated_by='scripts/original_cpu/convert.py'))
    if root:
        result['kind']='circuit';result.pop('ports',None)
        result['name']='Original Digital CPU — GENERATED topology port'
        boot='Boot ROM selected with --program.' if program else 'Boots the original CALLRET program (output 1–10).'
        result['description']='Generated from Bryan’s pinned Digital source, preserving its modules and two 50 Hz oscillators. '+boot+' This is a converted circuit, not an editor-built CPU.'
        result['definitions']=list(DEFS.values())
    return result

def main():
    faithful=lower('CPU.dig',root=True,program=args.program)
    artifact=OUT/'original_digital_cpu_generated.json'
    artifact.write_text(json.dumps(faithful,indent=2)+'\n')
    print(f'Converted {len(DEFS)} definitions, {len(faithful["components"])} root components into {artifact}')

if __name__=='__main__':main()
