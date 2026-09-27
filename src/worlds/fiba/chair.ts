import {
  BufferAttribute, CatmullRomCurve3, CylinderGeometry, ExtrudeGeometry,
  Group, Mesh, MeshStandardMaterial, Shape, TubeGeometry, Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { fabric } from './textures';

/** IMG_9386–9389: a single upholstered office-chair back, loose head pillow,
 * shallow waterfall seat and curved, thin pads over articulated black supports.
 * Measurements are visual estimates in metres, not product measurements.
 */
export function buildFibaChair(seatTop: number, resources: { dispose(): void }[]): Group {
  const chair = new Group();
  const keep = <T extends { dispose(): void }>(item: T): T => { resources.push(item); return item; };
  const cloth = (kind: 'plain' | 'tufted' | 'channels', seed: number) => {
    const f = fabric(kind, seed);
    resources.push(f.map, f.bump);
    return keep(new MeshStandardMaterial({ map: f.map, bumpMap: f.bump,
      bumpScale: 0.0007, roughness: 0.94, color: 0xf0efec }));
  };
  const upholstery = cloth('plain', 9);
  const stitched = cloth('channels', 9);
  const seatCloth = cloth('tufted', 3);
  const black = keep(new MeshStandardMaterial({ color: 0x222326, roughness: 0.65 }));
  const seam = keep(new MeshStandardMaterial({ color: 0x45474a, roughness: 1 }));
  const chrome = keep(new MeshStandardMaterial({ color: 0xb6bcc2, roughness: 0.24, metalness: 0.95 }));
  const box = (parent: Group, size: number[], at: number[], radius: number, material: MeshStandardMaterial, sculpt?: (x: number,y: number,z: number) => number[]) => {
    const g = keep(new RoundedBoxGeometry(size[0],size[1],size[2],12,radius));
    if (sculpt) {
      const a = g.attributes.position as BufferAttribute;
      for(let i=0;i<a.count;i++) { const p=sculpt(a.getX(i),a.getY(i),a.getZ(i)); a.setXYZ(i,p[0],p[1],p[2]); }
      g.computeVertexNormals();
    }
    const m = new Mesh(g,material);
    m.position.fromArray(at); m.castShadow=m.receiveShadow=true; parent.add(m); return m;
  };
  const tube = (parent: Group, points: number[][], radius: number, material: MeshStandardMaterial, closed=false) => {
    const curve=new CatmullRomCurve3(points.map(p=>new Vector3(...p)),closed,'centripetal');
    const m=new Mesh(keep(new TubeGeometry(curve,64,radius,8,closed)),material);
    m.castShadow=m.receiveShadow=true; parent.add(m); return m;
  };
  const cylinder = (parent: Group, top: number,bottom: number,height: number,at: number[],material: MeshStandardMaterial) => {
    const m=new Mesh(keep(new CylinderGeometry(top,bottom,height,28)),material);
    m.position.fromArray(at); m.castShadow=m.receiveShadow=true; parent.add(m); return m;
  };

  // The top is at seatTop throughout Fiba's footprint, so paws and the flank
  // share an actual support plane. The front rolls away below that plane.
  box(chair,[0.60,0.10,0.57],[0,seatTop-0.05,0.025],0.045,seatCloth,(x,y,z)=>[
    x*(1+0.035*z/0.285), y, z,
  ]);


  const back=new Group(); back.position.set(0,seatTop-0.008,-0.245); back.rotation.x=-0.14; chair.add(back);
  // A continuous shell with subtle vertical channels, not stacked separate cushions.
  box(back,[0.53,0.81,0.11],[0,0.391,-0.018],0.049,stitched,(x,y,z)=> {
    const waist=1-0.06*Math.exp(-Math.pow((y+0.08)/0.23,2));
    const front=Math.max(0,z/0.055);
    const lumbar=0.021*Math.exp(-Math.pow((y+0.22)/0.15,2));
    const cup=0.012*Math.pow(Math.abs(x)/0.265,2);
    return [x*waist,y,z+front*(lumbar+cup)];
  });
  // Loose pillow: fuller in the middle and drawn in at the four corners.
  const pillow=box(back,[0.335,0.225,0.070],[0,0.548,0.064],0.029,upholstery,(x,y,z)=> {
    const ux=x/0.1675, uy=y/0.1125;
    return [x*(0.93+0.07*uy*uy),y*(0.94+0.06*ux*ux),z+Math.max(0,z/0.035)*0.022*(1-ux*ux)*(1-uy*uy)];
  });
  pillow.rotation.z=-0.025;


  const support=new Shape();
  support.moveTo(-0.207,0.744);
  support.bezierCurveTo(-0.10,0.769,0.10,0.751,0.184,0.719);
  support.bezierCurveTo(0.213,0.705,0.208,0.677,0.194,0.650);
  support.bezierCurveTo(0.176,0.603,0.163,0.540,0.114,0.484);
  support.bezierCurveTo(0.093,0.463,0.049,0.473,0.055,0.508);
  support.bezierCurveTo(0.063,0.553,0.126,0.588,0.141,0.677);
  support.bezierCurveTo(0.063,0.715,-0.086,0.727,-0.207,0.713);
  support.closePath();
  const supportGeo=keep(new ExtrudeGeometry(support,{depth:0.026,bevelEnabled:true,bevelSegments:4,bevelSize:0.006,bevelThickness:0.004,curveSegments:24}));
  supportGeo.translate(0,0,-0.013);
  for(const side of [-1,1]) {
    const arm=new Mesh(supportGeo,black); arm.rotation.y=-Math.PI/2; arm.position.x=side*0.329;
    arm.castShadow=arm.receiveShadow=true; chair.add(arm);
    // Thin elongated cushions with an actual longitudinal arch and flat top.
    const pad=box(chair,[0.096,0.034,0.426],[side*0.334,0.750,-0.006],0.016,upholstery,(x,y,z)=>[
      x*(1+0.10*z/0.213),y+0.018*(1-Math.pow(z/0.213,2))-0.045*z,z,
    ]);
    pad.rotation.y=side*0.065;
    const pivot=cylinder(chair,0.024,0.024,0.031,[side*0.344,0.688,0.174],black); pivot.rotation.z=Math.PI/2;
    const screw=cylinder(chair,0.008,0.008,0.034,[side*0.346,0.688,0.174],seam); screw.rotation.z=Math.PI/2;
    box(chair,[0.035,0.035,0.21],[side*0.278,seatTop-0.098,-0.01],0.01,black);
  }
  box(chair,[0.29,0.047,0.29],[0,seatTop-0.119,-0.005],0.016,black);
  cylinder(chair,0.027,0.027,0.16,[0,0.304,0],chrome);
  cylinder(chair,0.038,0.044,0.16,[0,0.164,0],black);
  for(let i=0;i<5;i++) {
    const a=i/5*Math.PI*2+0.25;
    const direction=(r:number,y:number)=>[Math.cos(a)*r,y,Math.sin(a)*r];
    tube(chair,[direction(0.026,0.15),direction(0.12,0.12),direction(0.25,0.082),direction(0.326,0.069)],0.018,chrome);
    const caster=new Group(); caster.position.set(Math.cos(a)*0.326,0.034,Math.sin(a)*0.326); caster.rotation.y=-a; chair.add(caster);
    for(const z of [-0.018,0.018]) { const wheel=cylinder(caster,0.030,0.030,0.023,[0,0,z],black); wheel.rotation.x=Math.PI/2; }
  }
  return chair;
}
