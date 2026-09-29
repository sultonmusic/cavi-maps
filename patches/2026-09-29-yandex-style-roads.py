"""Yandex-style road rendering patch for the built Cavi Maps bundle.

Usage: python3 patch.py <in.js> <out.js>
Every replacement must match exactly once, otherwise the script aborts.
"""
import sys

src, dst = sys.argv[1], sys.argv[2]
s = open(src, encoding="utf-8").read()


def rep(old, new, count=1):
    global s
    n = s.count(old)
    if n != count:
        sys.exit(f"expected {count} match(es), found {n}: {old[:90]}")
    s = s.replace(old, new)


# ---------------------------------------------------------------- helpers
HELPERS = r"""
function CmS(e,t){let n=e.map(e=>[e[0],e[1],t(e)?1:0]);for(let e=0;e<3&&n.length>2;e++){let e=[n[0]];for(let t=1;t<n.length-1;t++){let r=n[t-1],i=n[t],a=n[t+1],o=Math.cos(i[1]*Math.PI/180)*111320,s=(r[0]-i[0])*o,c=(r[1]-i[1])*110540,l=(a[0]-i[0])*o,u=(a[1]-i[1])*110540,d=Math.hypot(s,c),f=Math.hypot(l,u);if(i[2]||!d||!f){e.push(i);continue}let p=Math.acos(Math.max(-1,Math.min(1,-(s*l+c*u)/(d*f))))*180/Math.PI;if(p<3||p>115){e.push(i);continue}let m=Math.min(.25,12/d),h=Math.min(.25,12/f);e.push([i[0]+(r[0]-i[0])*m,i[1]+(r[1]-i[1])*m,0],[i[0]+(a[0]-i[0])*h,i[1]+(a[1]-i[1])*h,0])}e.push(n[n.length-1]),n=e}return n.map(e=>[e[0],e[1]])}
function CmW(e=!1){let t=r=>[`*`,[`+`,[`get`,`w`],e?1.4:0],2**r/61170];return[`interpolate`,[`exponential`,2],[`zoom`],...wf.filter(([e])=>e<16).flatMap(([t,n])=>[t,(e?Math.min(2.2,Math.max(.5,n*.3)):0)+n]),16,[`max`,e?9:7.3,t(16)],17,[`max`,e?11.5:9,t(17)],18,[`max`,e?14:11,t(18)],22,t(22)]}
function CmA(e,t,n){if(!t.cmSeg){let r=t.line??n.get(t.owner)?.coordinates;if(!r||r.length<2)return 0;let i=1/0,a=Math.cos(t.lat*Math.PI/180);for(let n=1;n<r.length;n++){let[e,o]=r[n-1],[s,c]=r[n],l=(s-e)*a,u=c-o,d=l*l+u*u,f=(t.lon-e)*a,p=t.lat-o,m=d?Math.max(0,Math.min(1,(f*l+p*u)/d)):0,h=Math.hypot(f-l*m,p-u*m);h<i&&(i=h,t.cmSeg=[r[n-1],r[n]])}}let r=e.project(t.cmSeg[0]),i=e.project(t.cmSeg[1]);if(Math.hypot(i.x-r.x,i.y-r.y)<1)return 0;let a=Math.atan2(i.y-r.y,i.x-r.x);return a>Math.PI/2?a-Math.PI:a<-Math.PI/2?a+Math.PI:a}
function CmArrow(){let e=document.createElement(`canvas`);e.width=44,e.height=24;let t=e.getContext(`2d`);if(!t)return null;t.strokeStyle=`#7c8297`,t.fillStyle=`#7c8297`,t.lineWidth=3.2,t.lineCap=`round`,t.beginPath(),t.moveTo(6,12),t.lineTo(28,12),t.stroke(),t.beginPath(),t.moveTo(40,12),t.lineTo(26,4),t.lineTo(26,20),t.closePath(),t.fill();return t.getImageData(0,0,44,24)}
""".strip().replace("\n", "")
rep("function vH(e,t){gV();", HELPERS + "function vH(e,t){gV();")

# ---------------------------------------------------------------- palette
# Yandex-like cool light-grey asphalt with white edges and white lane marks.
rep("RB=`#a9abad`,zB=`#ddd9ce`,BB=`#f3f3ef`", "RB=`#c4c9d6`,zB=`#ffffff`,BB=`#ffffff`")
rep("`#b4b7ba`", "`#cdd1dc`", count=2)

# Plain (non-asphalt) roads: keep yellow main roads at city zoom, but fade to
# white with a light grey casing once the real-width asphalt appears, so no
# orange rim peeks out from under the asphalt any more.
rep('"line-color":[`match`,[`get`,`kind`],`road-main`,`#d8bb85`,`#d9d3c8`]',
    '"line-color":[`interpolate`,[`linear`],[`zoom`],15,[`match`,[`get`,`kind`],`road-main`,`#d8bb85`,`#d9d3c8`],16.5,`#dfe1e8`]')
rep('"line-color":[`match`,[`get`,`kind`],`road-main`,`#ffe1a1`,`road-secondary`,`#fffaf0`,`#ffffff`]',
    '"line-color":[`interpolate`,[`linear`],[`zoom`],15,[`match`,[`get`,`kind`],`road-main`,`#ffe1a1`,`road-secondary`,`#fffaf0`,`#ffffff`],16.5,`#ffffff`]')

# ---------------------------------------------------------------- asphalt as smooth lines
# The live (atlas-roads) asphalt is now drawn at every zoom as round-joined
# lines whose width follows the real carriageway width in metres, instead of
# switching to hand-built polygons at z16 (those had the jagged corners).
rep('{id:`asphalt-casing-live`,type:`line`,source:`live`,minzoom:10,layout:{"line-cap":`round`,"line-join":`round`},paint:{"line-color":zB,"line-width":ZB(!0),"line-opacity":QB}}',
    '{id:`asphalt-casing-live`,type:`line`,source:`live`,minzoom:10,layout:{"line-cap":`round`,"line-join":`round`},paint:{"line-color":zB,"line-width":CmW(!0)}}')
rep('{id:`asphalt-surface-live`,type:`line`,source:`live`,minzoom:10,layout:{"line-cap":`round`,"line-join":`round`},paint:{"line-color":RB,"line-width":ZB(),"line-opacity":QB}}',
    '{id:`asphalt-surface-live`,type:`line`,source:`live`,minzoom:10,layout:{"line-cap":`round`,"line-join":`round`},paint:{"line-color":RB,"line-width":CmW()}}')

# One-way direction arrows, like Yandex.
rep("{id:`asphalt-zebra`",
    '{id:`asphalt-oneway`,type:`symbol`,source:`live`,minzoom:16,filter:[`==`,[`get`,`ow`],1],layout:{"symbol-placement":`line`,"symbol-spacing":110,"icon-image":`atlas-oneway`,"icon-rotation-alignment":`map`,"icon-pitch-alignment":`map`,"icon-allow-overlap":!0,"icon-ignore-placement":!0,"icon-size":[`interpolate`,[`linear`],[`zoom`],16,.65,19,1]},paint:{"icon-opacity":.9}},{id:`asphalt-zebra`')
rep("n.on(`styleimagemissing`,e=>{if($z(n,e.id)||e.id!==GB||n.hasImage(GB))return;",
    "n.on(`styleimagemissing`,e=>{if($z(n,e.id))return;if(e.id===`atlas-oneway`){if(!n.hasImage(e.id)){let t=CmArrow();t&&n.addImage(e.id,t,{pixelRatio:2})}return}if(e.id!==GB||n.hasImage(GB))return;")

OLD_F = ("function F(){let e=new Set(P.map(e=>e.id)),t=P.concat([...M.values()].filter(t=>!e.has(t.id)));"
         "h(`live`,{type:`FeatureCollection`,features:t.map(e=>D(e.coordinates,{id:e.id}))});"
         "let n=t.map(e=>Ef(e.asphalt,!!e.oneway)/2),r=e=>`${e[0].toFixed(6)},${e[1].toFixed(6)}`,i=new Map;"
         "t.forEach((e,t)=>{for(let n of new Set(e.coordinates.map(r))){let e=i.get(n);e?e.push(t):i.set(n,[t])}});"
         "let a=[],o=[],s=[];t.forEach((e,t)=>{let c=n[t],l=e.coordinates,u=e=>(i.get(r(e))??[]).reduce((e,r)=>r===t?e:Math.max(e,n[r]),0),"
         "d=e=>{let t=u(e);return t?Math.min(c,t):c},f=[d(l[0]),d(l[l.length-1])];"
         "for(let e of Pf(l,c*2+.6,[f[0]+.3,f[1]+.3]))a.push(O(e,`kerb`));for(let e of Pf(l,c*2,f))o.push(O(e,`surface`));"
         "for(let t of Ff(e,u))s.push(D(t.coordinates,{kind:t.kind}))}),"
         "h(`asphalt`,{type:`FeatureCollection`,features:a.concat(o,s)}),k=zf(t),z(),A&&ze(A),d.invalidate()}")
NEW_F = ("function F(){let e=new Set(P.map(e=>e.id)),t=P.concat([...M.values()].filter(t=>!e.has(t.id)));"
         "let n=t.map(e=>Ef(e.asphalt,!!e.oneway)/2),r=e=>`${e[0].toFixed(6)},${e[1].toFixed(6)}`,i=new Map;"
         "t.forEach((e,t)=>{for(let n of new Set(e.coordinates.map(r))){let e=i.get(n);e?e.push(t):i.set(n,[t])}});"
         "let a=t.map(e=>CmS(e.coordinates,e=>(i.get(r(e))?.length??0)>1));"
         "h(`live`,{type:`FeatureCollection`,features:t.map((e,t)=>D(a[t],{id:e.id,w:n[t]*2,ow:e.oneway?1:0}))});"
         "let s=[];t.forEach((e,t)=>{let u=e=>(i.get(r(e))??[]).reduce((e,r)=>r===t?e:Math.max(e,n[r]),0);"
         "for(let o of Ff({...e,coordinates:a[t]},u))s.push(D(o.coordinates,{kind:o.kind}))}),"
         "h(`asphalt`,{type:`FeatureCollection`,features:s}),k=zf(t),z(),A&&ze(A),d.invalidate()}")
rep(OLD_F, NEW_F)

# ---------------------------------------------------------------- road labels
# Labels come one per OSM way, so a street split into 20 ways was printed up
# to 20 times. Draw each street name once per ~320 px, rotated along the road.
rep("S=[];let f=iB(", "S=[];let cmZ=[];let f=iB(")
rep("let h=t.kind===`place`&&t.name.length>28?t.name.slice(0,27).trimEnd()+`…`:t.name,g=r.measureText(h).width+12,_=m+(t.kind===`place`?2:8),v=[a.x-g/2,a.y-_/2,a.x+g/2,a.y+_/2];"
    "d.some(e=>e[0]<v[2]&&e[2]>v[0]&&e[1]<v[3]&&e[3]>v[1])||(d.push(v),S.push({box:v,label:t}),r.textAlign=`center`,r.textBaseline=`middle`,r.lineWidth=3.5,r.strokeStyle=`#ffffffeb`,r.strokeText(h,a.x,a.y),"
    "r.fillStyle=t.kind===`house`?`#94836a`:t.kind===`road`?`#7a7467`:t.kind===`place`?yz.label:`#4e6254`,r.fillText(h,a.x,a.y))",
    "if(t.kind===`road`&&cmZ.some(e=>e.name===t.name&&Math.hypot(e.x-a.x,e.y-a.y)<320))continue;"
    "let h=t.kind===`place`&&t.name.length>28?t.name.slice(0,27).trimEnd()+`…`:t.name,g=r.measureText(h).width+12,_=m+(t.kind===`place`?2:8),"
    "cmQ=t.kind===`road`?CmA(n,t,M):0,cmU=Math.abs(Math.cos(cmQ)),cmV=Math.abs(Math.sin(cmQ)),cmX=(g*cmU+_*cmV)/2,cmY=(g*cmV+_*cmU)/2,"
    "v=[a.x-cmX,a.y-cmY,a.x+cmX,a.y+cmY];"
    "d.some(e=>e[0]<v[2]&&e[2]>v[0]&&e[1]<v[3]&&e[3]>v[1])||(d.push(v),S.push({box:v,label:t}),t.kind===`road`&&cmZ.push({name:t.name,x:a.x,y:a.y}),"
    "r.save(),r.translate(a.x,a.y),r.rotate(cmQ),r.textAlign=`center`,r.textBaseline=`middle`,r.lineJoin=`round`,r.lineWidth=3.5,r.strokeStyle=`#ffffffeb`,r.strokeText(h,0,0),"
    "r.fillStyle=t.kind===`house`?`#94836a`:t.kind===`road`?`#565b69`:t.kind===`place`?yz.label:`#4e6254`,r.fillText(h,0,0),r.restore())")
rep("kind:`road`,minzoom:16,maxzoom:20,owner:e}", "kind:`road`,minzoom:16,maxzoom:20,owner:e,line:t.coordinates}")

open(dst, "w", encoding="utf-8").write(s)
print("patched OK", len(s))
