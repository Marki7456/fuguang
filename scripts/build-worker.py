import base64, io, json, pathlib, zipfile

root = pathlib.Path(__file__).resolve().parent.parent
assets = {}
for f in sorted((root/'public').rglob('*')):
    if f.is_file():
        binary = f.suffix == '.png'
        assets['/'+str(f.relative_to(root/'public'))] = {'binary':binary,'data':base64.b64encode(f.read_bytes()).decode() if binary else f.read_text()}
source = io.BytesIO()
with zipfile.ZipFile(source,'w',zipfile.ZIP_DEFLATED) as archive:
    paths = [p for p in root.rglob('*') if p.is_file() and not any(x in p.relative_to(root).parts for x in ['.git','dist','node_modules','.sites-workflow']) and p.relative_to(root).as_posix() not in ['worker/index.js'] and p.suffix!='.zip']
    for f in sorted(paths):
        rel=f.relative_to(root).as_posix()
        if rel.startswith('.openai/') and rel!='.openai/hosting.json':continue
        data=f.read_bytes()
        if rel=='.openai/hosting.json':data=b'{"d1":null,"r2":null}\n'
        info=zipfile.ZipInfo('ios-location-fork/'+rel,(2026,10,28,0,0,0))
        info.compress_type=zipfile.ZIP_DEFLATED
        archive.writestr(info,data)
text='// Generated from public/ and worker/handler.js. Run python3 scripts/build-worker.py.\n'
text+='const ASSETS = '+json.dumps(assets,ensure_ascii=False)+';\n'
text+='const SOURCE_ARCHIVE = '+json.dumps(base64.b64encode(source.getvalue()).decode())+';\n'
text+=(root/'worker/handler.js').read_text()
(root/'worker/index.js').write_text(text)
print('Prepared Worker with',len(assets),'assets and complete corresponding source archive.')
