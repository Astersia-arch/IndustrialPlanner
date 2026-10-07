// 每工作组一条独立退火链；64 个 invocation 合作评分，链内状态保存在 workgroup。
// 这是候选生成器：端口重分配、环境、供电和 Dense 验收仍由 CPU 的完整规则决定。
// geometry / edges 的固定布局由 CompactLayoutSearch.layoutBatch 生成；每条链只写自己的 output。
// 连通标签最多传播 128 轮，保守误拒只损失搜索机会，不构成最终合法性判定。
@group(0) @binding(0) var<storage,read> p:array<i32>;
@group(0) @binding(1) var<storage,read> geometry:array<i32>;
@group(0) @binding(2) var<storage,read> edges:array<i32>;
@group(0) @binding(3) var<storage,read> pairs:array<i32>;
@group(0) @binding(4) var<storage,read> initial:array<i32>;
@group(0) @binding(5) var<storage,read_write> output:array<i32>;
var<workgroup> config:array<i32,9>;
var<workgroup> pose:array<vec3<i32>,64>;
var<workgroup> previousPose:array<vec3<i32>,64>;
var<workgroup> bestPose:array<vec3<i32>,64>;
var<workgroup> sums:array<f32,64>;
var<workgroup> regions:array<atomic<u32>,4900>;
var<workgroup> changed:atomic<u32>;
var<workgroup> stable:u32;
var<workgroup> randomState:u32;
var<workgroup> chosen:i32;
var<workgroup> saved:vec3<i32>;
var<workgroup> current:f32;
var<workgroup> best:f32;
fn rnd()->u32 {
  var x=randomState;
  x=x^(x<<13u);
  x=x^(x>>17u);
  x=x^(x<<5u);
  randomState=x;
  return x;
}
fn dim(n:i32,field:i32)->i32{
  return geometry[(n*4+pose[n].z)*40+field];
}
fn inside(q:vec2<i32>,n:i32)->bool{
  let a=pose[n];
  return q.x>=a.x&&q.y>=a.y&&q.x<a.x+dim(n,0)&&q.y<a.y+dim(n,1);
}
fn endpoint(e:i32,destination:bool,outside:bool)->vec2<i32>{
  let o=e*40;
  let n=edges[o+select(0,1,destination)];
  let r=pose[n].z;
  let k=o+8+select(0,16,destination)+r*4+select(2,0,outside);
  return pose[n].xy+vec2<i32>(edges[k],edges[k+1]);
}
fn score(lane:u32)->f32{
  var cost=0.0;
  let n=p[0];
  let width=p[2];
  let height=p[3];
  for(var i=i32(lane);i<n;i+=64){
    let a=pose[i];
    let w=dim(i,0);
    let h=dim(i,1);
    cost+=f32(max(0,-a.x)+max(0,-a.y)+max(0,a.x+w-width)+max(0,a.y+h-height))*10000.0;
    for(var k=0;k<dim(i,5);k++){
      let point=pose[i].xy+vec2<i32>(dim(i,8+k*2),dim(i,9+k*2));
      for(var j=0;j<n;j++){
        if(inside(point,j)){
          cost+=10000.0;
        }
      }
    }
    for(var j=0;j<i;j++) {
      let b=pose[j];
      let overlap=max(0,min(a.x+w,b.x+dim(j,0))-max(a.x,b.x))*max(0,min(a.y+h,b.y+dim(j,1))-max(a.y,b.y));
      if(pairs[i*n+j]==0){
        cost+=f32(overlap)*10000.0;
      }
    }
  }
  for(var e=i32(lane);e<p[1];e+=64){
    let o=e*40;
    let source=edges[o];
    let destination=edges[o+1];
    let kind=edges[o+2];
    let a=endpoint(e,false,true);
    let b=endpoint(e,true,true);
    let ac=endpoint(e,false,false);
    let bc=endpoint(e,true,false);
    let direct=edges[o+3]==0&&all(a==bc)&&all(b==ac)&&edges[o+5]!=0;
    let distance=abs(a.x-b.x)+abs(a.y-b.y);
    cost+=f32(max(distance,edges[o+3]-1)*edges[o+4])*10.0;
    cost+=f32(max(0,edges[o+3]-distance-1))*3000.0;
    if(!direct){
      cost+=f32(max(0,-a.x)+max(0,-a.y)+max(0,a.x+1-width)+max(0,a.y+1-height)+max(0,-b.x)+max(0,-b.y)+max(0,b.x+1-width)+max(0,b.y+1-height))*10000.0;
      for(var i=0;i<n;i++){
        if((dim(i,4)&kind)!=0){
          if(inside(a,i)){
            cost+=10000.0;
          }
          if(inside(b,i)){
            cost+=10000.0;
          }
        }
      }
      for(var f=0;f<e;f++){
        if(edges[f*40+2]!=kind){
          continue;
        }
        let c=endpoint(f,false,true);
        let d=endpoint(f,true,true);
        if(all(a==c)||all(a==d)){
          cost+=10000.0;
        }
        if(all(b==c)||all(b==d)){
          cost+=10000.0;
        }
      }
    }
  }
  if(lane==0u){
    var warehouse=0;
    var belts=0;
    for(var i=0;i<n;i++){
      let side=dim(i,2);
      let kind=dim(i,3);
      if(side>=0){
        if(kind==1){
          warehouse|=1<<u32(side);
        }
        if(kind==2){
          belts|=1<<u32(side);
        }
      }
    }
    if((warehouse&belts)!=0){
      cost+=10000.0;
    }
    if(p[7]==1&&countOneBits(u32(warehouse))>1u){
      cost+=10000.0;
    }
  }
  return cost;
}
fn label(x:i32,y:i32,width:i32,height:i32)->u32 {
  if(x<0||y<0||x>=width||y>=height){
    return 0u;
  }
  return atomicLoad(&regions[y*width+x]);
}
fn adjacent(point:vec2<i32>,direction:i32)->vec2<i32>{
  switch direction{
    case 0:{
      return point+vec2<i32>(0,-1);
    }
    case 1:{
      return point+vec2<i32>(1,0);
    }
    case 2:{
      return point+vec2<i32>(0,1);
    }
    default:{
      return point+vec2<i32>(-1,0);
    }
  }
}
fn connections(lane:u32,n:i32,edgeCount:i32,width:i32,height:i32)->f32 {
  var cost=0.0;
  for(var kind=1;kind<=2;kind++){
    for(var cell=i32(lane);cell<width*height;cell+=64){
      let point=vec2<i32>(cell%width,cell/width);
      var blocked=false;
      for(var i=0;i<n;i++){
        if((dim(i,4)&kind)!=0&&inside(point,i)){
          blocked=true;
          break;
        }
        for(var k=0;k<dim(i,5);k++){
          if(all(point==pose[i].xy+vec2<i32>(dim(i,8+k*2),dim(i,9+k*2)))){
            blocked=true;
          }
        }
      }
      for(var e=0;e<edgeCount;e++){
        if(edges[e*40+2]==kind&&(all(point==endpoint(e,false,true))||all(point==endpoint(e,true,true)))){
          blocked=true;
        }
      }
      atomicStore(&regions[cell],select(u32(cell+1),0u,blocked));
    }
    workgroupBarrier();
    for(var round=0;round<128;round++){
      if(lane==0u){
        atomicStore(&changed,0u);
      }
      workgroupBarrier();
      for(var cell=i32(lane);cell<width*height;cell+=64){
        let old=atomicLoad(&regions[cell]);
        if(old==0u){
          continue;
        }
        let point=vec2<i32>(cell%width,cell/width);
        var value=old;
        for(var d=0;d<4;d++){
          let q=adjacent(point,d);
          let next=label(q.x,q.y,width,height);
          if(next>0u){
            value=min(value,next);
          }
        }
        if(value<atomicMin(&regions[cell],value)){
          atomicStore(&changed,1u);
        }
      }
      workgroupBarrier();
      if(lane==0u){
        stable=atomicLoad(&changed);
      }
      if(workgroupUniformLoad(&stable)==0u){
        break;
      }
    }
    for(var e=i32(lane);e<edgeCount;e+=64){
      let o=e*40;
      if(edges[o+2]!=kind){
        continue;
      }
      let a=endpoint(e,false,true);
      let b=endpoint(e,true,true);
      let direct=edges[o+3]==0&&all(a==endpoint(e,true,false))&&all(b==endpoint(e,false,false))&&edges[o+5]!=0;
      if(direct||abs(a.x-b.x)+abs(a.y-b.y)<=1){
        continue;
      }
      var connected=false;
      for(var ad=0;ad<4;ad++){
        let ap=adjacent(a,ad);
        let al=label(ap.x,ap.y,width,height);
        if(al==0u){
          continue;
        }
        for(var bd=0;bd<4;bd++){
          let bp=adjacent(b,bd);
          if(al==label(bp.x,bp.y,width,height)){
            connected=true;
          }
        }
      }
      if(!connected){
        cost+=10000.0;
      }
    }
    workgroupBarrier();
  }
  return cost;
}
@compute @workgroup_size(64) fn main(@builtin(local_invocation_index) lane:u32,@builtin(workgroup_id) group:vec3<u32>){
  if(lane==0u){
    for(var i=0;i<9;i++){
      config[i]=p[i];
    }
  }
  let configuration=workgroupUniformLoad(&config);
  let n=configuration[0];
  let steps=configuration[4];
  let id=group.x;
  for(var i=i32(lane);i<n;i+=64){
    pose[i]=vec3<i32>(initial[i*3],initial[i*3+1],initial[i*3+2]);
    bestPose[i]=pose[i];
  }
  if(lane==0u){
    randomState=(u32(p[5])+id*747796405u+2891336453u)|1u;
    best=1e30;
    current=1e30;
  }
  workgroupBarrier();
  for(var step=-1;step<steps;step++){
    if(step>=0&&lane==0u){
      for(var i=0;i<n;i++){
        previousPose[i]=pose[i];
      }
      chosen=i32(rnd()%u32(n));
      saved=pose[chosen];
      var a=saved;
      if(rnd()%5u==0u){
        a.z=i32(rnd()%4u);
      }
      pose[chosen]=a;
      let w=dim(chosen,0);
      let h=dim(chosen,1);
      if(rnd()%4u==0u){
        a.x=i32(rnd()%u32(max(1,p[2]-w+1)));
        a.y=i32(rnd()%u32(max(1,p[3]-h+1)));
      }
      else{
        a.x=clamp(a.x+i32(rnd()%7u)-3,0,max(0,p[2]-w));
        a.y=clamp(a.y+i32(rnd()%7u)-3,0,max(0,p[3]-h));
      }
      if(rnd()%3u==0u){
        for(var offset=0;offset<configuration[1];offset++){
          let e=i32((rnd()+u32(offset))%u32(configuration[1]));
          let startNode=edges[e*40];
          let endNode=edges[e*40+1];
          if(startNode!=chosen&&endNode!=chosen){
            continue;
          }
          let other=endpoint(e,startNode==chosen,true);
          let otherCell=endpoint(e,startNode==chosen,false);
          let shift=other-otherCell;
          let portOffset=e*40+8+select(0,16,endNode==chosen);
          var local=vec2<i32>(0,0);
          for(var turn=0;turn<4;turn++){
            let k=portOffset+turn*4;
            let out=vec2<i32>(edges[k],edges[k+1]);
            let cell=vec2<i32>(edges[k+2],edges[k+3]);
            if(all(out-cell==-shift)){
              a.z=turn;
              local=cell;
              break;
            }
          }
          pose[chosen]=a;
          let gap=max(edges[e*40+3],select(1,0,edges[e*40+5]!=0))+i32(rnd()%3u);
          a.x=other.x+shift.x*gap-local.x;
          a.y=other.y+shift.y*gap-local.y;
          break;
        }
      }
      if(rnd()%8u==0u){
        let partner=i32(rnd()%u32(n));
        let old=pose[partner];
        pose[partner]=vec3<i32>(saved.xy,old.z);
        a.x=old.x;
        a.y=old.y;
      }
      let side=dim(chosen,2);
      if(side==0){
        a.y=0;
      }
      if(side==1){
        a.x=p[2]-w;
      }
      if(side==2){
        a.y=p[3]-h;
      }
      if(side==3){
        a.x=0;
      }
      pose[chosen]=a;
      for(var child=0;child<n;child++){
        if(dim(child,6)==chosen+1){
          let old=previousPose[child];
          let dx=old.x-saved.x;
          let dy=old.y-saved.y;
          let turn=(a.z-saved.z+4)%4;
          let pw=geometry[(chosen*4+saved.z)*40];
          let ph=geometry[(chosen*4+saved.z)*40+1];
          let cw=geometry[(child*4+old.z)*40];
          let ch=geometry[(child*4+old.z)*40+1];
          var point=vec2<i32>(dx,dy);
          if(turn==1){
            point=vec2<i32>(ph-dy-ch,dx);
          }
          if(turn==2){
            point=vec2<i32>(pw-dx-cw,ph-dy-ch);
          }
          if(turn==3){
            point=vec2<i32>(dy,pw-dx-cw);
          }
          pose[child]=vec3<i32>(a.xy+point,(old.z+turn)%4);
        }
      }
    }
    if(lane==0u){
      for(var node=0;node<n;node++){
        let side=dim(node,2);
        if(side<0){
          continue;
        }
        var a=pose[node];
        let w=dim(node,0);
        let h=dim(node,1);
        a.x=clamp(a.x,0,max(0,p[2]-w));
        a.y=clamp(a.y,0,max(0,p[3]-h));
        if(side==0){
          a.y=0;
        }
        if(side==1){
          a.x=p[2]-w;
        }
        if(side==2){
          a.y=p[3]-h;
        }
        if(side==3){
          a.x=0;
        }
        pose[node]=a;
      }
    }
    workgroupBarrier();
    sums[lane]=score(lane);
    if(configuration[8]!=0){
      sums[lane]+=connections(lane,n,configuration[1],configuration[2],configuration[3]);
    }
    workgroupBarrier();
    var stride=32u;
    loop{
      if(lane<stride){
        sums[lane]+=sums[lane+stride];
      }
      workgroupBarrier();
      if(stride==1u){
        break;
      }
      stride/=2u;
    }
    if(lane==0u){
      let cost=sums[0];
      if(cost<best){
        best=cost;
        for(var i=0;i<n;i++){
          bestPose[i]=pose[i];
        }
      }
      let temperature=max(10.0,f32(p[6])*(1.0-f32(max(0,step))/f32(steps)));
      if(cost<=current||f32(rnd())/4294967296.0<exp((current-cost)/temperature)){
        current=cost;
      }
      else if(step>=0){
        for(var i=0;i<n;i++){
          pose[i]=previousPose[i];
        }
      }
    }
    workgroupBarrier();
  }
  let offset=i32(id)*(n*3+1);
  for(var i=i32(lane);i<n;i+=64){
    let a=bestPose[i];
    output[offset+1+i*3]=a.x;
    output[offset+2+i*3]=a.y;
    output[offset+3+i*3]=a.z;
  }
  if(lane==0u){
    output[offset]=i32(best);
  }
}
