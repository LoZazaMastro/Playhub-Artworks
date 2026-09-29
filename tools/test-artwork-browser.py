#!/usr/bin/env python3
"""Real Chromium image tests, with actual Python transfer RPCs and synthetic fixtures.
Requires Pillow and Playwright for TESTING ONLY (no added plugin runtime dependencies).
All external network requests are blocked; source bytes come from local fixture adapters. This is not a live Steam/Decky session.
"""
from __future__ import annotations
import argparse, asyncio, base64, io, json, shutil, struct, subprocess, sys, tempfile, zlib
from urllib.parse import urlparse
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tests'))
from test_artwork_transfer116 import plugin, png, chunk
from test_resource_safety import BACKEND

async def run():
    from PIL import Image, ImageDraw
    from playwright.async_api import async_playwright
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report',type=Path)
    parser.add_argument('--chromium',default=shutil.which('chromium'))
    args=parser.parse_args()
    errors=[]
    with tempfile.TemporaryDirectory() as temporary:
        root=Path(temporary); instance=plugin()
        im=Image.new('RGBA',(3840,1240),(0,0,0,0));ImageDraw.Draw(im).rectangle((100,100,3740,1140),fill=(25,80,150,255));im.save(root/'large.png',compress_level=0);im.close()
        im=Image.new('RGBA',(7680,4320),(10,20,150,255));im.save(root/'8k.png');im.close()
        im=Image.new('RGBA',(12000,800),(0,0,0,0));ImageDraw.Draw(im).rectangle((800,100,11200,700),fill=(245,25,20,255));im.save(root/'logo.png');im.close()
        Image.new('RGBA',(100,100),(0,0,0,0)).save(root/'empty.png')
        Image.new('RGBA',(1,1),(255,255,255,255)).save(root/'tiny.png')
        # A genuine 16-bit RGB PNG, not a fake extension or a mocked bitmap.
        row=b'\0'+struct.pack('>HHH',55000,18000,7000)*3840
        encoded=zlib.compress(row*1240,level=0)
        (root/'sixteen.png').write_bytes(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',3840,1240,16,2,0,0,0))+chunk(b'IDAT',encoded)+chunk(b'IEND',b''))
        del encoded,row
        first=Image.new('RGBA',(20,20),(255,0,0,255));second=Image.new('RGBA',(20,20),(0,0,255,255))
        buffer=io.BytesIO();first.save(buffer,format='PNG',save_all=True,append_images=[second],duration=100,loop=0)
        animation=buffer.getvalue();first.close();second.close()
        for name,padding in [('animated.png',3*1024*1024),('animated-large.png',17*1024*1024)]:
            (root/name).write_bytes(animation[:33]+chunk(b'tEXt',b'Comment\0'+b'x'*padding)+animation[33:])
        (root/'bomb.png').write_bytes(png(32768,32768))
        (root/'broken.png').write_text('<html>synthetic CDN error</html>')
        base='https://artwork-fixtures.invalid'
        class FixtureResponse:
            def __init__(self, request, **_kwargs):
                filename=Path(urlparse(request.full_url).path).name
                self.path=root/filename
                self.headers={'Content-Length':str(self.path.stat().st_size),'Content-Type':'image/png'}
            def __enter__(self):self.file=self.path.open('rb');return self
            def read(self,n):return self.file.read(n)
            def __exit__(self,*_args):self.file.close()
        async def fixture(name):
            return base64.b64encode((root/Path(name).name).read_bytes()).decode('ascii')
        rpc_count=0;max_rpc=0
        async def rpc(method,args):
            nonlocal rpc_count,max_rpc
            if method not in {'prepare_artwork_transfer','read_artwork_transfer_chunk','release_artwork_transfer','cancel_artwork_transfer','preserve_perfect_source_from_transfer','prepare_perfect_source_transfer'}:
                raise RuntimeError('Unexpected test RPC: '+method)
            rpc_count+=1
            result=await getattr(instance,method)(*args)
            if method=='read_artwork_transfer_chunk':max_rpc=max(max_rpc,len(result))
            return result
        try:
            with patch.object(BACKEND,'ARTWORK_TRANSFER_DIR',root/'transfers'),patch.object(BACKEND,'PERFECT_SOURCE_DIR',root/'originals'),patch.object(BACKEND,'_diagnostic',lambda *_a,**_k:None),patch.object(BACKEND,'urlopen',FixtureResponse):
                async with async_playwright() as pw:
                    browser=await pw.chromium.launch(executable_path=args.chromium,headless=True,args=['--no-sandbox'])
                    context=await browser.new_context()
                    await context.route('**/*',lambda route:route.abort())
                    page=await context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
                    await page.set_content('<html><body>Artwork fixture tests</body></html>')
                    await page.expose_function('testFixture',fixture)
                    await page.evaluate("() => { window.fetch=async url=>new Response(Uint8Array.from(atob(await testFixture(new URL(url).pathname)), c=>c.charCodeAt(0)),{status:200,headers:{'content-type':'image/png'}}); }")
                    await page.expose_function('testRpc',rpc)
                    harness=subprocess.check_output(['node',str(ROOT/'tools/prepare-artwork-browser116.cjs')],text=True)
                    await page.add_script_tag(content=harness)
                    await page.add_script_tag(path=str(ROOT/'tests/browser-artwork116.js'))
                    paths={n:str(root/(n+'.png')) for n in ['large','sixteen','logo','animated']}
                    results=await page.evaluate('options=>runArtworkTests(options)',{'base':base,'paths':paths})
                    version=browser.version;await browser.close()
            results.append({'name':'All raw temporary transfers released','passed':not instance._transfers and not list((root/'transfers').glob('*.bin'))})
            original=root/'originals/10004_hero.png'
            results.append({'name':'Successful auto composition retains exact original bytes','passed':original.exists() and original.read_bytes()==(root/'large.png').read_bytes()})
        finally:
            instance._shutdown_event.set();instance._download_executor.shutdown(wait=True)

        report={'browser':version,'scope':'Real Chromium codecs/canvas + Python transfer RPC; Steam/Decky/provider adapters, no live account','rpcCalls':rpc_count,'largestBase64RpcBytes':max_rpc,'browserErrors':errors,'results':results}
        if args.report:
            args.report.parent.mkdir(parents=True,exist_ok=True);args.report.write_text(json.dumps(report,indent=2)+'\n')
        for result in results: print(('PASS' if result['passed'] else 'FAIL')+': '+result['name']+((' — '+result['error']) if 'error'in result else ''))
        print(f"{sum(r['passed'] for r in results)}/{len(results)} passed; maximum artwork RPC = {max_rpc} bytes")
        if errors or not all(r['passed'] for r in results):raise SystemExit(1)

if __name__=='__main__':asyncio.run(run())
