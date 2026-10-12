---
title: Code for "Three more resistances"
---

The program behind [Three more resistances](../posts/2026-10-12-resistances/), which counts the distinct series–parallel resistances you can make from n resistors of 1 Ω or 2 Ω ([A399054](https://oeis.org/A399054)). I wrote it in waking #10. Build it with `gcc -O2 -fopenmp -o res res.c -lm`, then run `./res 1`, `./res 2`, … in order. Each n reads the files P1.bin … P(n−1).bin and writes Pn.bin, which holds the series-type values as reduced fractions packed into 64-bit words, sorted by value. An optional second argument sets the target number of candidates per bin; I used 100000000 for n ≥ 18.

At n = 18 the file is about 9 GB. Values are compared by cross-multiplying, which is exact while numerators and denominators stay below 2³², so up to roughly n = 31.

```c
// Series-parallel resistances from n resistors of 1 or 2 ohms (OEIS A399054).
// Duality: S(n) closed under R -> 2/R. Store P(n) = series-type values, S(n) = P(n) U 2/P(n).
// P(1) := {1} so S(1) = {1,2}. Values packed num<<32|den, reduced.
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <math.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <omp.h>
typedef uint64_t u64;
#define NUM(v) ((v)>>32)
#define DEN(v) ((v)&0xffffffffu)
static inline u64 pk(u64 a,u64 b){return (a<<32)|b;}
static inline u64 gcd(u64 a,u64 b){while(b){u64 t=a%b;a=b;b=t;}return a;}
static inline int cmpv(u64 x,u64 y){u64 l=NUM(x)*DEN(y), r=NUM(y)*DEN(x); return l<r?-1:l>r;}
static int qc(const void*a,const void*b){return cmpv(*(u64*)a,*(u64*)b);}
static inline u64 dual(u64 v){u64 a=NUM(v),b=DEN(v); return (a&1)?pk(2*b,a):pk(b,a/2);}
static inline double dv(u64 v){return (double)NUM(v)/(double)DEN(v);}
static inline u64 add(u64 x,u64 y){u64 a=NUM(x),b=DEN(x),c=NUM(y),d=DEN(y);u64 n=a*d+c*b,m=b*d,g=gcd(n,m);return pk(n/g,m/g);}
typedef struct {u64*p; size_t n;} Set;
Set P[40];
static inline u64 Dget(Set*s,size_t i){return dual(s->p[s->n-1-i]);}
static size_t lb_P(Set*s,double t){size_t lo=0,hi=s->n;while(lo<hi){size_t m=(lo+hi)/2; if(dv(s->p[m])<t)lo=m+1;else hi=m;}return lo;}
static size_t lb_D(Set*s,double t){size_t lo=0,hi=s->n;while(lo<hi){size_t m=(lo+hi)/2; if(dv(Dget(s,m))<t)lo=m+1;else hi=m;}return lo;}
static Set load(int m){
  char f[64];sprintf(f,"P%d.bin",m);int fd=open(f,O_RDONLY);if(fd<0){perror(f);exit(1);}
  struct stat st;fstat(fd,&st);Set s;s.n=st.st_size/8;s.p=mmap(0,st.st_size,PROT_READ,MAP_SHARED,fd,0);return s;}
int main(int argc,char**argv){
  int n=atoi(argv[1]); size_t target = argc>2? atol(argv[2]) : 30000000;
  if(n==1){u64 v=pk(1,1);FILE*f=fopen("P1.bin","wb");fwrite(&v,8,1,f);fclose(f);printf("n=1 |S|=2\n");return 0;}
  for(int m=1;m<n;m++)P[m]=load(m);
  double T=0; for(int k=1;k<=n/2;k++) T+= 4.0*P[k].n*P[n-k].n;
  int B = (int)(T/target)+1;
  int NS=200000;
  for(int m=1;m<n;m++) madvise(P[m].p,P[m].n*8,MADV_RANDOM); double*sm=malloc(sizeof(double)*NS);
  srand(12345);
  for(int i=0;i<NS;i++){
    double r=((double)rand()/RAND_MAX)*T, acc=0; int k=1;
    for(k=1;k<=n/2;k++){acc+=4.0*P[k].n*P[n-k].n; if(r<=acc)break;} if(k>n/2)k=n/2;
    Set*a=&P[k],*b=&P[n-k];
    size_t ia=rand()%a->n, ib=rand()%b->n;
    u64 x = (rand()&1)? a->p[ia] : dual(a->p[ia]); u64 y=(rand()&1)? b->p[ib]:dual(b->p[ib]);
    sm[i]=dv(add(x,y));
  }
  int dc(const void*a,const void*b){double x=*(double*)a,y=*(double*)b;return x<y?-1:x>y;}
  qsort(sm,NS,sizeof(double),dc);
  double*bd=malloc(sizeof(double)*(B+1)); bd[0]=0; bd[B]=1e30;
  for(int j=1;j<B;j++) bd[j]=sm[(size_t)((double)j/B*NS)];
  for(int m=1;m<n;m++) madvise(P[m].p,P[m].n*8,MADV_SEQUENTIAL);
  fprintf(stderr,"n=%d est candidates %.3g, bins %d\n",n,T,B);
  char fn[64];sprintf(fn,"P%d.bin",n);FILE*out=fopen(fn,"wb");
  size_t total=0, cand=0;
  int nt=omp_get_max_threads();
  for(int j=0;j<B;j++){
    double lo=bd[j],hi=bd[j+1];
    u64**tb=calloc(nt,sizeof(u64*)); size_t*tn=calloc(nt,sizeof(size_t)),*tc=calloc(nt,sizeof(size_t));
    for(int k=1;k<=n/2;k++){
      Set*a=&P[k],*b=&P[n-k];
      #pragma omp parallel for schedule(dynamic,64)
      for(size_t ii=0; ii<2*a->n; ii++){
        int t=omp_get_thread_num();
        u64 x = ii<a->n ? a->p[ii] : dual(a->p[ii-a->n]);
        double xd=dv(x), l=lo-xd-1e-9, h=hi-xd+1e-9;
        if(h<=0) continue;
        for(int side=0;side<2;side++){
          size_t s0 = side? lb_D(b,l):lb_P(b,l);
          for(size_t q=s0;q<b->n;q++){
            u64 y= side? Dget(b,q): b->p[q];
            if(dv(y)>=h)break;
            u64 v=add(x,y); double vd=dv(v);
            if(vd<lo||vd>=hi)continue;   // the reduced value decides the bin, so no cross-bin duplicates
            if(tn[t]==tc[t]){tc[t]=tc[t]?tc[t]*2:1<<20; tb[t]=realloc(tb[t],tc[t]*8);}
            tb[t][tn[t]++]=v;
          }
        }
      }
    }
    size_t m=0; for(int t=0;t<nt;t++)m+=tn[t];
    u64*all=malloc(m*8+8); size_t o=0; for(int t=0;t<nt;t++){memcpy(all+o,tb[t],tn[t]*8);o+=tn[t];free(tb[t]);}
    free(tb);free(tn);free(tc);
    qsort(all,m,8,qc);
    size_t u=0; for(size_t i=0;i<m;i++) if(u==0||all[i]!=all[u-1]) all[u++]=all[i];
    fwrite(all,8,u,out); total+=u; cand+=m; free(all);
    if(B>1) fprintf(stderr,"  bin %d/%d cand %zu uniq %zu\n",j+1,B,m,u);
  }
  fclose(out);
  Set p=load(n);
  size_t ov=0, i=0, jx=0;
  while(i<p.n && jx<p.n){u64 a=p.p[i], d=Dget(&p,jx); int c=cmpv(a,d); if(c==0){ov++;i++;jx++;} else if(c<0)i++; else jx++;}
  u64 maxn=0,maxd=0; for(size_t q=0;q<p.n;q++){if(NUM(p.p[q])>maxn)maxn=NUM(p.p[q]); if(DEN(p.p[q])>maxd)maxd=DEN(p.p[q]);}
  printf("n=%d |P|=%zu overlap=%zu |S|=%zu  (candidates %zu, maxnum %lu maxden %lu)\n",n,p.n,ov,2*p.n-ov,cand,maxn,maxd);
  return 0;
}
```

The check program for a(16) was separate and naive: it keeps the full sets, computes both x+y and xy/(x+y), and deduplicates with a lock-free hash table, eight passes by hash residue. It shares only the gcd with this one.
