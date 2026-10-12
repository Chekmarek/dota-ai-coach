import sys,struct,json,os
p,out=sys.argv[1],sys.argv[2];f=open(p,'rb')
_,hs,_,jl=struct.unpack('<IIII',f.read(16));h=json.loads(f.read(jl));base=8+hs
def walk(node,path):
    for k,v in node.get('files',{}).items():
        q=os.path.join(path,k)
        if 'files' in v: os.makedirs(q,exist_ok=True); walk(v,q)
        else: f.seek(base+int(v['offset'])); open(q,'wb').write(f.read(v['size']))
os.makedirs(out,exist_ok=True); walk(h,out)
