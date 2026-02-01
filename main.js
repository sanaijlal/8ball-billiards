// main.js - 8-Ball Billiards (MVP)
// Single-file runtime (no build). Author: AI Assistant (MVP).
(function(){
  'use strict';

  /* ========== Configuration / Tuning ========== */
  const TABLE_WIDTH = 800;
  const TABLE_HEIGHT = 400; // Playable area
  const BALL_RADIUS = 10;
  const BALL_MASS = 3;
  const RESTITUTION = 0.92;
  const RAIL_RESTITUTION = 0.88;
  const FRICTION = 0.9985; // velocity multiplier per frame (simple rolling resistance)
  const SUBSTEPS = 8;
  const MAX_POWER = 50;
  const EPSILON = 0.05; // Stop threshold
  const POCKET_RADIUS = 26;
  const SIDE_POCKET_RADIUS = 22;

  const COLORS = {
    // Standard pool colors
    1: '#FDD017', 9: '#FDD017', // Yellow
    2: '#0000FF', 10: '#0000FF', // Blue
    3: '#FF0000', 11: '#FF0000', // Red
    4: '#800080', 12: '#800080', // Purple
    5: '#FFA500', 13: '#FFA500', // Orange
    6: '#008000', 14: '#008000', // Green
    7: '#800000', 15: '#800000', // Maroon
    8: '#000000',                // Black
    0: '#FFFFFF'                 // Cue
  };

  /* ========== Utilities ========== */
  function clamp(v,a,b){return Math.max(a,Math.min(b,v));}
  function len(x,y){return Math.hypot(x,y);} 
  function dist(x1,y1,x2,y2){return Math.hypot(x2-x1,y2-y1);}

  /* ========== Input Manager ========== */
  class Input{
    constructor(canvas){
      this.canvas = canvas;
      this.mouse = {x:0,y:0,down:false,startX:0,startY:0,shift:false};
      this.touchId = null;
      
      // Event listeners
      window.addEventListener('mousemove', e=> this._onMove(e));
      window.addEventListener('mousedown', e=> this._onDown(e)); // Changed from canvas to window to catch off-canvas clicks
      window.addEventListener('mouseup', e=> this._onUp(e));
      
      canvas.addEventListener('touchstart', e=> this._onTouchStart(e), {passive:false});
      window.addEventListener('touchend', e=> this._onTouchEnd(e));
      window.addEventListener('touchcancel', e=> this._onTouchEnd(e));
      window.addEventListener('touchmove', e=> this._onTouchMove(e), {passive:false});

      window.addEventListener('keydown', e=> this._onKey(e));
      
      this.keys = new Set();
      this.onRestart = null; this.onPause = null; this.onDebug = null;
    }

    _toLocal(e,touch){
      const rect = this.canvas.getBoundingClientRect();
      const client = touch || e;
      // Map screen coords to logical canvas size, accounting for canvas scaling
      const scaleX = this.canvas.width / rect.width;
      const scaleY = this.canvas.height / rect.height;
      const dpr = window.devicePixelRatio || 1;
      return {
        x: (client.clientX - rect.left) * scaleX / dpr,
        y: (client.clientY - rect.top) * scaleY / dpr
      };
    }

    _onMove(e){ const p = this._toLocal(e); this.mouse.x = p.x; this.mouse.y = p.y; this.mouse.shift = e.shiftKey; }
    _onDown(e){ 
      // Ignore click if on a button
      if(e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
      if(e.target.id === 'spinCircle' || e.target.closest('#spinCircle')) return;

      const p = this._toLocal(e); 
      this.mouse.down = true; 
      this.mouse.shift = e.shiftKey;
      this.mouse.startX = p.x; 
      this.mouse.startY = p.y; 
      this.mouse.x = p.x; 
      this.mouse.y = p.y; 
    }
    _onUp(e){ this.mouse.down = false; this.mouse.shift = e.shiftKey; }

    _onTouchStart(e){ 
      if(this.touchId !== null) return;
      const t = e.changedTouches[0];
      this.touchId = t.identifier;
      const p = this._toLocal(null, t);
      this.mouse.down = true;
      this.mouse.shift = false;
      this.mouse.startX = p.x; this.mouse.startY = p.y;
      this.mouse.x = p.x; this.mouse.y = p.y;
      e.preventDefault();
    }
    _onTouchMove(e){
      for(let i=0; i<e.changedTouches.length; i++){
        if(e.changedTouches[i].identifier === this.touchId){
          const p = this._toLocal(null, e.changedTouches[i]);
          this.mouse.x = p.x; this.mouse.y = p.y;
          e.preventDefault();
        }
      }
    }
    _onTouchEnd(e){ this.touchId=null; this.mouse.down=false; }

    getPointer(){
      return this.mouse;
    }

    _onKey(e){
      if(e.code === 'KeyR' && this.onRestart) this.onRestart();
      if(e.code === 'KeyP' && this.onPause) this.onPause();
      if(e.code === 'KeyD' && this.onDebug) this.onDebug();
    }
  }

  /* ========== Core Classes ========== */
  class Ball {
    constructor(id, x, y, color){
      this.id = id; // 0=cue, 1-7=solids, 8=black, 9-15=stripes
      this.x = x; this.y = y;
      this.vx = 0; this.vy = 0;
      this.r = BALL_RADIUS;
      this.color = color;
      this.pocketed = false;
      this.isCue = (id === 0);
      
      // Rotation state (Euler angles or Quaternion would be better, but simple 2D offset hack works for top-down)
      // Actually, for true rolling, we need access to a local texture transform.
      // We will track an internal "rotation vector" [rx, ry, rz] to simulate the sphere texture moving.
      this.rotation = {x:0, y:0, z:0}; 
    }
    
    get type() {
      if(this.id === 0) return 'CUE';
      if(this.id === 8) return 'EIGHT';
      if(this.id < 8) return 'SOLID';
      return 'STRIPE';
    }
  }

  class Table {
    constructor(width, height, margin){
      this.playW = width;
      this.playH = height;
      this.margin = margin;
      // Play area bounds
      this.left = margin;
      this.right = margin + width;
      this.top = margin;
      this.bottom = margin + height;
      
      // Pockets positions
      this.pockets = [
        {x:this.left, y:this.top, r: POCKET_RADIUS},
        {x:this.right/2 + this.left/2, y:this.top, r: SIDE_POCKET_RADIUS},
        {x:this.right, y:this.top, r: POCKET_RADIUS},
        {x:this.left, y:this.bottom, r: POCKET_RADIUS},
        {x:this.right/2 + this.left/2, y:this.bottom, r: SIDE_POCKET_RADIUS},
        {x:this.right, y:this.bottom, r: POCKET_RADIUS}
      ];
    }
  }

  class Physics {
    constructor(table, balls){
      this.table = table;
      this.balls = balls;
      // Per-shot simulation stats
      this.events = {
        firstHit: null, // ball contacted by cue ball first
        railsBeforeContact: 0, // not used in simple rules, but typically tracked
        railsAfterContact: 0,
        pocketedIds: []
      };
      this.railsHitThisFrame = new Set();
      this.cueSpin = {x:0, y:0}; // -1 to 1
    }

    resetEvents(){
      this.events = { firstHit: null, railsBeforeContact: 0, railsAfterContact: 0, pocketedIds: [] };
    }

    step(dt){
      // Fixed time step for stability
      const dtSub = 1 / SUBSTEPS; 

      for(let s=0; s<SUBSTEPS; s++){
        // 1. Move & Friction
        this.railsHitThisFrame.clear();
        for(let b of this.balls){
          if(b.pocketed) continue;
          
          if(Math.abs(b.vx)<EPSILON && Math.abs(b.vy)<EPSILON){
            b.vx=0; b.vy=0;
          } else {
            b.x += b.vx * dtSub;
            b.y += b.vy * dtSub;
            b.vx *= FRICTION;
            b.vy *= FRICTION;
            
            // Update rotation based on distance travelled
            // d = v * t
            // Angle change = d / r (radians)
            // If dragging, axis of rotation is perpendicular to velocity.
            // v = (vx, vy). Perpendicular = (-vy, vx).
            const speed = Math.hypot(b.vx, b.vy);
            if(speed > 0){
               const dist = speed * dtSub;
               const angle = dist / b.r;
               // Axis of rotation (normalized perp vector)
               const ax = -b.vy / speed;
               const ay = b.vx / speed;
               
               // Update Euler approximation (Just x/y visual offset for texture)
               // This attempts to simulate the ball rolling.
               // We'll accumulate "texture shift" coordinates.
               // x rotation moves texture vertically? No 3D sphere mapping here.
               // Simplest 2D hack: shift the texture coordinates by dist
               b.rotation.x += ax * angle;
               b.rotation.y += ay * angle;
            }
          }
        }

        // 2. Collisions
        // Ball-Ball
        for(let i=0; i<this.balls.length; i++){
          for(let j=i+1; j<this.balls.length; j++){
            this.resolveBallBall(this.balls[i], this.balls[j]);
          }
        }
        // Ball-Table
        for(let b of this.balls){
          if(b.pocketed) continue;
          this.checkPockets(b); // Check if inside pocket BEFORE wall collision
          if(b.pocketed) continue; 
          this.resolveBallTable(b);
        }

        // Track rail hits (simple unique count per substep is approximation)
        if(this.railsHitThisFrame.size > 0 && this.firstHitRegistered){
          // If we already hit a ball, these count as post-contact rail hits
           // For MVP break rule: "at least 4 rails hit" is total rails hit during shot
        }
      }
    }

    resolveBallBall(b1, b2){
      if(b1.pocketed || b2.pocketed) return;
      const dx = b2.x - b1.x;
      const dy = b2.y - b1.y;
      const d = Math.sqrt(dx*dx + dy*dy);
      
      if(d < b1.r + b2.r){
        // Overlap
        const nx = dx/d;
        const ny = dy/d;
        const pen = (b1.r + b2.r - d) * 0.5;
        
        // Separation
        b1.x -= nx * pen; b1.y -= ny * pen;
        b2.x += nx * pen; b2.y += ny * pen;

        // Velocity resolve
        const dvx = b1.vx - b2.vx;
        const dvy = b1.vy - b2.vy;
        const velAlongNormal = dvx*nx + dvy*ny;

        if(velAlongNormal < 0) return; // Moving apart

        // Record first hit for rules
        if(b1.isCue && this.events.firstHit === null) this.events.firstHit = b2;
        if(b2.isCue && this.events.firstHit === null) this.events.firstHit = b1;

        // Impulse
        const j = -(1 + RESTITUTION) * velAlongNormal;
        // invMass sum = 1/1 + 1/1 = 2
        const imp = j / 2;
        
        b1.vx += nx * imp; b1.vy += ny * imp;
        b2.vx -= nx * imp; b2.vy -= ny * imp;

        // Apply Spin Effect (Fake Physics for MVP)
        // If one is cue ball and it's the FIRST hit
        if((b1.isCue || b2.isCue) && this.events.firstHit && (this.events.firstHit === b1 || this.events.firstHit === b2)){
             const cue = b1.isCue ? b1 : b2;
             // Only apply if we have active spin
             if(Math.abs(this.cueSpin.y) > 0.1){
                  // Follow/Draw acts along the tangent line (perpendicular to collision normal)? 
                  // No, Follow/Draw acts along the initial velocity vector (or "forward" vector).
                  // But usually we simplify: 
                  // Follow pushes cue ball *into* object ball (forward).
                  // Draw pulls cue ball *away* (backward).
                  
                  // Vector from Cue to Object is -Normal (if cue is b1, normal points b1->b2? No b2->b1 in code)
                  // dx = b2 - b1. 
                  // nx = dx/d.
                  // If b1 is cue, nx points AWAY from cue (towards Object). 
                  // So Forward = nx, Backward = -nx.
                  
                  // Wait, check normal logic:
                  // dx = b2.x - b1.x
                  // nx = dx/d   (Points b1 -> b2)
                  // b1 separation -= nx * pen (Moves b1 "back").
                  
                  // So nx is direction FROM b1 TO b2.
                  // If b1 is Cue: Forward is nx.
                  // If b2 is Cue: Forward is -nx.
                  
                  const forwardX = b1.isCue ? nx : -nx;
                  const forwardY = b1.isCue ? ny : -ny;
                  
                  // Apply velocity boost
                  // Top spin (y < 0 in UI usually means Top? Or Up? Let's check UI logic later. Usually Up = Top Spin = Follow)
                  // Let's assume Spin Y: -1 (Top) to +1 (Bottom/Draw). 
                  // Actually standard UI: Top is Y<0.
                  
                  // Force magnitude
                  // Scaled by impact velocity to prevent soft shots from Rocketing away
                  // velAlongNormal is negative on impact, so we use abs
                  const impactSpeed = Math.abs(velAlongNormal);
                  const spinForce = -this.cueSpin.y * impactSpeed * 0.6; 
                  
                  cue.vx += forwardX * spinForce;
                  cue.vy += forwardY * spinForce;
             }
        }
      }
    }

    resolveBallTable(b){
      let collided = false;
      // Left
      if(b.x < this.table.left + b.r){
        b.x = this.table.left + b.r;
        b.vx = -b.vx * RAIL_RESTITUTION;
        collided = true;
      }
      // Right
      if(b.x > this.table.right - b.r){
        b.x = this.table.right - b.r;
        b.vx = -b.vx * RAIL_RESTITUTION;
        collided = true;
      }
      // Top
      if(b.y < this.table.top + b.r){
        b.y = this.table.top + b.r;
        b.vy = -b.vy * RAIL_RESTITUTION;
        collided = true;
      }
      // Bottom
      if(b.y > this.table.bottom - b.r){
        b.y = this.table.bottom - b.r;
        b.vy = -b.vy * RAIL_RESTITUTION;
        collided = true;
      }
      if(collided) this.events.railsBeforeContact++; // Simply counting rail hits globally for now
    }

    checkPockets(b){
      for(let p of this.table.pockets){
        if(len(b.x - p.x, b.y - p.y) < p.r){ // Simple point check
          b.pocketed = true;
          b.vx = 0; b.vy = 0;
          this.events.pocketedIds.push(b.id);
          return;
        }
      }
    }

    isStable(){
      for(let b of this.balls){
        if(!b.pocketed && (Math.abs(b.vx) > 0 || Math.abs(b.vy) > 0)) return false;
      }
      return true;
    }
  }

  /* ========== Rules / Game Logic ========== */
  class Game {
    constructor(){
      this.canvas = document.getElementById('tableCanvas');
      this.renderer = new Renderer(this.canvas);
      this.input = new Input(this.canvas);
      
      this.input.onRestart = () => this.initGame();
      this.input.onPause = () => { this.paused = !this.paused; };
      this.input.onDebug = () => { this.renderer.debug = !this.renderer.debug; };

      this.currentSpin = {x:0, y:0}; // Store spin here to persist across restarts
      this.initSpinControl();
      this.initGame();
      requestAnimationFrame(t => this.loop(t));
    }

    initSpinControl(){
        const circle = document.getElementById('spinCircle');
        const dot = document.getElementById('spinDot');
        
        let dragging = false;
        
        const updateSpin = (e) => {
            const rect = circle.getBoundingClientRect();
            let x = e.clientX - rect.left;
            let y = e.clientY - rect.top;
            
            // Clamp to radius
            const r = rect.width / 2;
            const dx = x - r;
            const dy = y - r;
            const dist = Math.sqrt(dx*dx + dy*dy);
            
            if(dist > r){
               const angle = Math.atan2(dy, dx);
               x = r + Math.cos(angle) * r;
               y = r + Math.sin(angle) * r;
            }
            
            // UI Update
            dot.style.left = x + 'px';
            dot.style.top = y + 'px';
            
            // Logic Update (-1 to 1)
            const sx = (x - r) / r;
            const sy = (y - r) / r;
            
            this.currentSpin = {x:sx, y:sy};
            if(this.physics) this.physics.cueSpin = this.currentSpin;
        };
        
        circle.addEventListener('mousedown', (e) => { dragging=true; updateSpin(e); e.stopPropagation(); }); 
        window.addEventListener('mousemove', (e) => { if(dragging) updateSpin(e); });
        window.addEventListener('mouseup', () => { dragging=false; });
    }

    initGame(){
      // Use logical dimensions from renderer, not physical canvas size
      const w = this.renderer.w;
      const h = this.renderer.h;
      const margin = 50;
      this.table = new Table(w - margin*2, h - margin*2, margin);
      
      // Rack Balls
      this.balls = [];
      this.cueBall = new Ball(0, this.table.left + this.table.playW*0.25, this.table.top + this.table.playH*0.5, COLORS[0]);
      this.balls.push(this.cueBall);
      this.setupRack();

      this.physics = new Physics(this.table, this.balls);
      this.physics.cueSpin = this.currentSpin; // Apply saved spin
      
      // State
      this.state = 'AIMING'; // AIMING, SHOOTING, SIMULATING, BALL_IN_HAND, GAME_OVER
      this.turn = 1; // Player 1 or 2
      this.groups = { 1: null, 2: null }; // 'SOLID' or 'STRIPE'
      this.message = "Breaking! Move mouse to aim, drag back to power.";
      this.turnMessage = "";
      this.foulMessage = "";
      this.openTable = true;
      this.shotCount = 0;
      this.lastTime = performance.now();
      this.paused = false;
      this.aimAngle = 0;
      this.lockedAngle = 0;
      this.wasDown = false;
      this.wasDownInHand = false;
      this.isMovingCueBall = false;
      this.dragStart = null;

      // Update UI
      this.updateHUD();
    }

    setupRack(){
      // Rack position (foot spot)
      const startX = this.table.left + this.table.playW * 0.75;
      const startY = this.table.top + this.table.playH * 0.5;
      const r = BALL_RADIUS;
      const gap = 0.5; // Tighter rack for better break
      
      // Typical 8-ball rack pattern (rows: 1, 2, 3, 4, 5)
      // 1 ball at apex. 8 ball in center. Corners: one stripe, one solid.
      const rows = 5;
      let added = 0;
      // Fixed rack setup for simplicity to Ensure 8 in middle and corners mix
      // Row 0: 1
      // Row 1: 2, 3
      // Row 2: 4, 8, 5
      // Row 3: 6, 7, 9, 10 
      // Row 4: 11,12,13,14,15 (We will shuffle types slightly or hardcode a valid rack)
      
      // Hardcoded legal rack positions relative to startX/Y
      // Visual rack layout:
      //      1
      //     9 2
      //    3 8 4  <- 8 in middle
      //   5 6 7 10
      // 11 12 13 14 15
      
      // To satisfy "randomness" we usually shuffle, but for MVP strict rack:
      // Apex: 1 (Solid)
      // Row 2: 9 (Stripe), 2 (Solid)
      // Row 3: 3 (Solid), 8 (Black), 10 (Stripe) (Corner is stripe?) - Rules say corners must be split
      // Let's just generate a valid pool of IDs and place them.
      
      const ids = [1,  9,2,  3,8,10,  4,5,11,6,  12,13,7,14,15]; 
      // Note: This is an approximation. 
      // real rack:
      // r0: 0,0 (1 ball)
      // r1: -1, 1 (2 balls)
      
      let idx = 0;
      for(let col=0; col<5; col++){
        for(let row=0; row<=col; row++){
          const x = startX + col * (2*r + gap) * Math.cos(Math.PI/6);
          const y = startY + (row - col/2) * (2*r + gap);
          this.balls.push(new Ball(ids[idx++], x, y, COLORS[ids[idx-1]]));
        }
      }
    }

    loop(now){
      try {
        requestAnimationFrame(t => this.loop(t));
        if(this.paused) return;
        const dt = (now - this.lastTime) / 1000;
        this.lastTime = now;

        this.update(dt);
        this.renderer.render(this);
      } catch(e) {
        console.error(e);
        // Draw error on canvas
        const ctx = this.renderer.ctx;
        ctx.fillStyle = 'black';
        ctx.fillRect(0,0,1000,600);
        ctx.fillStyle = 'red';
        ctx.font = '20px monospace';
        ctx.fillText("Error: " + e.message, 50, 50);
        ctx.fillText(e.stack, 50, 80);
        this.paused = true;
      }
    }

    update(dt){
      if(this.state === 'SIMULATING'){
        this.physics.step(dt);
        if(this.physics.isStable()){
          this.resolveShot();
        }
      } else if (this.state === 'AIMING'){
        this.handleAimInput();
      } else if (this.state === 'BALL_IN_HAND'){
        this.handleBallInHand();
      }
    }

    handleAimInput(){
      const input = this.input.getPointer();

      // --- Feature: Move Cue Ball on Break Shot ---
          if(this.shotCount === 0){
            // Detect click on ball
            if(input.down && !this.wasDown && !this.isMovingCueBall){
           const distToCue = Math.hypot(input.x - this.balls[0].x, input.y - this.balls[0].y);
           if(distToCue < BALL_RADIUS * 3){ // Extended hit area
             this.isMovingCueBall = true;
             this.wasDown = true; // Consume click
           }
          }
          
          if(this.isMovingCueBall){
             if(input.down){
                 // Drag
                 const limitX = this.table.left + this.table.playW * 0.3; // Restrict to kitchen
                 this.balls[0].x = clamp(input.x, this.table.left+BALL_RADIUS, limitX);
                 this.balls[0].y = clamp(input.y, this.table.top+BALL_RADIUS, this.table.bottom-BALL_RADIUS);
                 return; // Stop here, no aiming while moving
             } else {
                 // Drop
                 this.isMovingCueBall = false;
                 this.wasDown = false;
                 return;
             }
          }
      }
      
      // Phase 1: Passive Aim (update angle always when not locked)
      if(!this.wasDown){
          const dx = input.x - this.balls[0].x;
          const dy = input.y - this.balls[0].y;
          this.aimAngle = Math.atan2(dy, dx);
      }

      // Phase 2: Click to Lock & Drag for Power for shooting
      if(input.down && !this.balls[0].pocketed){ 
         if(!this.wasDown){
             // Start Drag
             this.dragStart = {x:input.x, y:input.y};
             this.wasDown = true;
             this.lockedAngle = this.aimAngle; // Lock current aim
         }
         // While down, we use lockedAngle. Power is dist(input, dragStart)
      } else if (!input.down && this.wasDown){
        // Release -> Shoot
        this.wasDown = false;
        
        // Calculate power from drag distance
        const dx = input.x - this.dragStart.x;
        const dy = input.y - this.dragStart.y;
        const dist = Math.sqrt(dx*dx + dy*dy);
        
        if(dist > 6){ // deadzone raised to avoid tiny accidental shots
          // Boost power for break shot (first shot)
          const limit = (this.shotCount === 0) ? 100 : MAX_POWER;
          // Reduce sensitivity: smaller multiplier gives finer control
          const power = Math.min(dist * 0.06, limit); 
          
          // Use LOCKED angle
          const angle = this.lockedAngle;
          
          this.cueBall.vx = Math.cos(angle) * power; 
          this.cueBall.vy = Math.sin(angle) * power;
          
          this.shotCount++;
          this.state = 'SIMULATING';
          this.physics.resetEvents();
        }
      }
    }

    handleBallInHand(){
      const m = this.input.mouse;
      // Clamp to table
      const r = BALL_RADIUS;
      let tx = clamp(m.x, this.table.left+r, this.table.right-r);
      let ty = clamp(m.y, this.table.top+r, this.table.bottom-r);
      
      // Check overlap
      let ok = true;
      for(let b of this.balls){
        if(b === this.cueBall || b.pocketed) continue;
        if(dist(tx,ty, b.x, b.y) < 2*r) ok = false;
      }
      
      // Ghost Ball logic is visual, but if they click we place
      if(m.down && !this.wasDownInHand && ok){
        this.cueBall.x = tx; 
        this.cueBall.y = ty;
        this.cueBall.vx = 0; 
        this.cueBall.vy = 0;
        this.cueBall.pocketed = false;
        this.state = 'AIMING';
        this.foulMessage = "";
        this.updateHUD();
      }
      this.wasDownInHand = m.down;
    }

    resolveShot(){
      const ev = this.physics.events;
      const pockets = ev.pocketedIds;
      let foul = false;
      let turnEnding = true;
      let foulReason = "";
      
      // Check Fouls
      // 1. Scratch
      if(this.cueBall.pocketed){
        foul = true;
        foulReason = "Scratch!";
      } 
      // 2. No hit
      else if(ev.firstHit === null){
        foul = true;
        foulReason = "No ball hit!";
      }
      // 3. Bad Hit (Groups Assigned)
      else if(!this.openTable){
        const myGroup = this.groups[this.turn];
        if(ev.firstHit.type !== myGroup && ev.firstHit.type !== 'EIGHT'){
           // Hitting 8 first is simplified as foul unless it's only ball left (handled by logic?)
           // Standard rules: hitting 8 first is foul unless 8 is the legal object ball (group cleared)
           foul = true;
           foulReason = "Wrong group hit first!";
        }
        else if(ev.firstHit.type === 'EIGHT'){
             // Can only hit 8 first if group is cleared
             const myBalls = this.balls.filter(b => !b.pocketed && b.type === myGroup);
             if(myBalls.length > 0){
               foul = true;
               foulReason = "Hit 8-ball too early!";
             }
        }
      }
      // 4. Break Rule (First Shot)
      if(this.balls.length === 16 && pockets.length === 0 && ev.railsBeforeContact < 4 && !foul){
         // Simplified check: checking initial state usually requires a flag "isBreak".
         // For MVP, we can skip strict break foul or just check "game start"
      }
      
      // 5. 8-Ball Pocketed
      const eightPocketed = pockets.includes(8);
      if(eightPocketed){
        // GOLDEN BREAK: If 8-ball pocketed on the break (first shot) and NOT a foul => instant win
        if(this.shotCount === 1){
          if(!foul){
            this.endGame(this.turn, "Golden Break! 8-ball pocketed on the break.");
            return;
          } else {
            this.endGame(this.turn === 1 ? 2 : 1, "8-ball fault on break!");
            return;
          }
        }

        const myGroup = this.groups[this.turn];
        // Win or Lose?
        // Lose if: Foul on shot OR Group not cleared
        const myBallsLeft = this.balls.filter(b => !b.pocketed && b.type === myGroup && b.id!==8);

        if(foul || (myGroup && myBallsLeft.length > 0) || (this.openTable && this.balls.length > 2)){
           // Early 8 ball or scratch on 8 ball
           this.endGame(this.turn === 1 ? 2 : 1, "8-ball fault!"); // Opponent wins
           return;
        } else {
           this.endGame(this.turn, "Perfect 8-ball!"); // Current player wins
           return;
        }
      }

      // Logic for Turn Switch
      if(!foul){
        if(pockets.length > 0){
          // Legal pocket?
          // If open table
          if(this.openTable){
             if(this.shotCount === 1){
                 // Break shot: continue if legal ball pocketed, but don't assign groups
                 const valid = pockets.some(id => id!==0 && id!==8);
                 turnEnding = !valid;
             } else {
                 // Determine groups
                 const firstScored = this.balls.find(b => b.id === pockets[0]);
                 if(firstScored && firstScored.id !== 0 && firstScored.id !== 8){
                   this.openTable = false;
                   this.groups[this.turn] = firstScored.type;
                   this.groups[this.turn===1?2:1] = firstScored.type==='SOLID'?'STRIPE':'SOLID';
                   turnEnding = false; // Continue
                 } else {
                   // Scored 0 or 8 (handled above)
                    turnEnding = true;
                 }
             }
          } else {
            // Groups assigned
            const myGroup = this.groups[this.turn];
            // Check if we pocketed ANY of our group
            const myPocketed = pockets.some(pid => {
               if(pid===0 || pid===8) return false;
               const b = this.balls.find(ball => ball.id === pid); // Note: ball is in list even if pocketed flag is true, but state might be old? The array references persist.
               // We need to look up type from ID logic since ball object might be reused/reset if we were fancy, but here permanent.
               const type = (pid < 8) ? 'SOLID' : 'STRIPE'; 
               return type === myGroup;
            });
            
            if(myPocketed) turnEnding = false;
            
            // If we also pocketed opponent ball, that's legal provided we hit ours first and pocketed ours (turn continues). 
            // Standard rules allow opponent ball pocketing if own is also pocketed legal.
          }
        }
      } else {
        turnEnding = true;
      }

      // Handle Scratch Return
      if(this.cueBall.pocketed){
        this.cueBall.pocketed = false; // Bring back for Ball in Hand
        this.state = 'BALL_IN_HAND';
      } else if (foul && !eightPocketed) {
         this.state = 'BALL_IN_HAND';
      } else {
         this.state = 'AIMING';
      }

      if(turnEnding){
        this.turn = this.turn === 1 ? 2 : 1;
        this.showTurnPopup();
      }

      // Messages
      this.foulMessage = foul ? `FOUL: ${foulReason}` : "";
      if(this.state === 'BALL_IN_HAND') this.foulMessage += " Ball in Hand!";
      
      // Auto-reset spin after shot
      this.currentSpin = {x:0, y:0};
      if(this.physics) this.physics.cueSpin = this.currentSpin;
      const spinDot = document.getElementById('spinDot');
      if(spinDot) { spinDot.style.left = '50%'; spinDot.style.top = '50%'; }

      this.updateHUD();
    }
  
    endGame(winner, reason){
      this.state = 'GAME_OVER';
      this.message = `GAME OVER! Player ${winner} WINS! (${reason})`;
      this.updateHUD();
    }

    updateHUD(){
      const p = document.getElementById('currentPlayer');
      const g = document.getElementById('groupType');
      const m = document.getElementById('msg');
      
      const p1Container = document.getElementById('p1Balls');
      const p2Container = document.getElementById('p2Balls');

      p.innerText = this.turn;
      p.style.color = this.turn === 1 ? '#44f' : '#f44';
      
      let grp = "Open Table";
      if(!this.openTable){
        grp = this.groups[this.turn] || "None";
      }
      g.innerText = grp;
      
      // Clear containers
      if(p1Container) p1Container.innerHTML = '';
      if(p2Container) p2Container.innerHTML = '';

      // --- Helper to create ball element ---
      const createBallDiv = (id, color) => {
         const div = document.createElement('div');
         div.className = 'mini-ball';
         // Inline styles to ensure visibility if CSS is cached/laggy
         div.style.width = '14px';
         div.style.height = '14px';
         div.style.borderRadius = '50%';
         div.style.border = '1px solid #333';
         div.style.display = 'inline-block';
         div.style.boxSizing = 'border-box';
         
         if(id > 8 && id < 16) {
           // Stripe
           div.style.background = `linear-gradient(90deg, #fff 25%, ${color} 25%, ${color} 75%, #fff 75%)`;
         } else {
           // Solid
           div.style.background = color;
         }
         return div;
      };

      // --- Determine which balls to show ---
      if(this.openTable){
          // Show transparent placeholders or all? 
          // Let's show Solids for P1 and Stripes for P2 for guidance, but faded
          const solids = [1,2,3,4,5,6,7];
          const stripes = [9,10,11,12,13,14,15];
          
          if(p1Container) {
            solids.forEach(id => {
               const b = this.balls.find(x=>x.id===id);
               if(b && !b.pocketed) {
                  const el = createBallDiv(id, COLORS[id]);
                  el.style.opacity = 0.5;
                  p1Container.appendChild(el);
               }
            });
          }
           if(p2Container) {
            stripes.forEach(id => {
               const b = this.balls.find(x=>x.id===id);
               if(b && !b.pocketed) {
                  const el = createBallDiv(id, COLORS[id]);
                  el.style.opacity = 0.5;
                  p2Container.appendChild(el);
               }
            });
          }

      } else {
          // Groups assigned
          const g1 = this.groups[1]; // 'SOLID' or 'STRIPE'
          const g2 = this.groups[2];
          
          const getRemaining = (type) => {
             return this.balls.filter(b => b.type === type && !b.pocketed && b.id !== 8 && b.id !== 0).sort((a,b)=>a.id-b.id);
          };

          if(p1Container && g1) {
             const balls = getRemaining(g1);
             if(balls.length === 0) {
                // Show 8 ball
                const b8 = this.balls.find(x=>x.id===8);
                if(b8 && !b8.pocketed) p1Container.appendChild(createBallDiv(8, '#000'));
             } else {
                balls.forEach(b => p1Container.appendChild(createBallDiv(b.id, COLORS[b.id])));
             }
          }

          if(p2Container && g2) {
             const balls = getRemaining(g2);
             if(balls.length === 0) {
                // Show 8 ball
                const b8 = this.balls.find(x=>x.id===8);
                if(b8 && !b8.pocketed) p2Container.appendChild(createBallDiv(8, '#000'));
             } else {
                balls.forEach(b => p2Container.appendChild(createBallDiv(b.id, COLORS[b.id])));
             }
          }
      }

      // Messages
      if(this.state === 'GAME_OVER'){
        m.innerText = this.message;
        m.style.color = '#0f0';
      } else {
        m.innerText = this.foulMessage || (this.state === 'BALL_IN_HAND' ? "Place the Cue Ball" : "Aim & Shoot");
        m.style.color = this.foulMessage ? '#f00' : '#eee';
      }
    }

    showTurnPopup(){
        const popup = document.getElementById('turnPopup');
        const num = document.getElementById('popupPlayerNum');
        if(popup && num){
            num.innerText = this.turn;
            popup.style.opacity = '1';
            // Reset transition to ensure it fades in
            popup.style.transition = 'opacity 0.2s';
            
            if(this.popupTimer) clearTimeout(this.popupTimer);
            this.popupTimer = setTimeout(() => {
                popup.style.opacity = '0';
            }, 500);
        }
    }
  }

  /* ========== Renderer ========== */
  class Renderer{
    constructor(canvas){
      this.ctx = canvas.getContext('2d');
      this.canvas = canvas;
      this.debug = false;
      this.resizeCanvas();
      
      // Handle window resize for responsive design
      window.addEventListener('resize', () => this.resizeCanvas());
    }
    
    resizeCanvas(){
      const dpr = window.devicePixelRatio || 1;
      const rect = this.canvas.getBoundingClientRect();
      
      // Set physical size
      this.canvas.width = rect.width * dpr;
      this.canvas.height = rect.height * dpr;
      
      // Scale context
      this.ctx.scale(dpr, dpr);
      
      this.w = rect.width;
      this.h = rect.height;
    }

    render(game){
      const ctx = this.ctx;
      const t = game.table;
      
      // 1. Background (Floor)
      const floorGrad = ctx.createRadialGradient(this.w/2, this.h/2, this.w/4, this.w/2, this.h/2, this.w);
      floorGrad.addColorStop(0, '#222');
      floorGrad.addColorStop(1, '#111');
      ctx.fillStyle = floorGrad;
      ctx.fillRect(0,0,this.w,this.h);
      
      // 2. Table Shadow
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = 40;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 20;

      // 3. Wood Frame
      const woodGrad = ctx.createLinearGradient(0, 0, this.w, this.h);
      woodGrad.addColorStop(0, '#5D4037');
      woodGrad.addColorStop(0.5, '#4E342E'); 
      woodGrad.addColorStop(1, '#3E2723');
      ctx.fillStyle = woodGrad;
      
      // Round rect for table frame
      this.roundRect(ctx, t.left - t.margin, t.top - t.margin, t.playW + t.margin*2, t.playH + t.margin*2, 25);
      ctx.fill();
      // Draw metal rivets on the rails
      (function drawRivets(){
        const rivetColor = '#9fb5c9';
        const rivetStroke = 'rgba(0,0,0,0.35)';
        const rv = 4; // rivet radius
        // helper to test if near pocket
        function nearPocket(x,y){
          for(let p of t.pockets){
            if(Math.hypot(x-p.x, y-p.y) < p.r + 12) return true;
          }
          return false;
        }
        // Top / Bottom long rails
        const countLong = Math.max(6, Math.floor(t.playW / 80));
        for(let i=0;i<=countLong;i++){
          const x = t.left + (i/(countLong)) * t.playW;
          const topY = t.top - t.margin/2;
          const botY = t.bottom + t.margin/2;
          if(!nearPocket(x, topY)){
            ctx.beginPath(); ctx.fillStyle = rivetColor; ctx.strokeStyle = rivetStroke; ctx.lineWidth = 1; ctx.arc(x, topY, rv, 0, Math.PI*2); ctx.fill(); ctx.stroke();
          }
          if(!nearPocket(x, botY)){
            ctx.beginPath(); ctx.fillStyle = rivetColor; ctx.strokeStyle = rivetStroke; ctx.lineWidth = 1; ctx.arc(x, botY, rv, 0, Math.PI*2); ctx.fill(); ctx.stroke();
          }
        }
        // Short rails left/right
        const countShort = Math.max(3, Math.floor(t.playH / 120));
        for(let i=1;i<=countShort;i++){
          const y = t.top + (i/countShort) * t.playH;
          const leftX = t.left - t.margin/2;
          const rightX = t.right + t.margin/2;
          if(!nearPocket(leftX, y)){
            ctx.beginPath(); ctx.fillStyle = rivetColor; ctx.strokeStyle = rivetStroke; ctx.lineWidth = 1; ctx.arc(leftX, y, rv, 0, Math.PI*2); ctx.fill(); ctx.stroke();
          }
          if(!nearPocket(rightX, y)){
            ctx.beginPath(); ctx.fillStyle = rivetColor; ctx.strokeStyle = rivetStroke; ctx.lineWidth = 1; ctx.arc(rightX, y, rv, 0, Math.PI*2); ctx.fill(); ctx.stroke();
          }
        }
      })();
      
      // Reset Shadow
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;

      // 4. Inner Rails (Dark Wood Inset)
      ctx.fillStyle = '#2b1b17'; 
      ctx.beginPath();
      const railInst = 15;
      this.roundRect(ctx, t.left - railInst, t.top - railInst, t.playW + railInst*2, t.playH + railInst*2, 10);
      // Add pocket cutouts
      for(let p of t.pockets){
        ctx.moveTo(p.x + p.r, p.y);
        if(p.y === t.top && p.r === SIDE_POCKET_RADIUS){
          // Top middle pocket: cut out bottom semicircle (counterclockwise from PI to 0)
          ctx.arc(p.x, p.y, p.r, Math.PI, 0, true);
        } else if(p.y === t.bottom && p.r === SIDE_POCKET_RADIUS){
          // Bottom middle pocket: cut out top semicircle (counterclockwise from 2PI to PI)
          ctx.arc(p.x, p.y, p.r, Math.PI*2, Math.PI, true);
        } else {
          // Corner pockets: cut out full circle (counterclockwise)
          ctx.arc(p.x, p.y, p.r, 0, Math.PI*2, true);
        }
      }
      ctx.fill('evenodd');

      

      // 5. Playing Surface (Synthwave / Outrun Style)
      ctx.save();
      ctx.beginPath();
      ctx.rect(t.left, t.top, t.playW, t.playH);
      ctx.clip();

      // Gradient Background (Green felt)
      const synthGrad = ctx.createLinearGradient(t.left, t.top, t.left, t.top + t.playH);
      synthGrad.addColorStop(0, '#0b6b0b'); // darker top
      synthGrad.addColorStop(0.5, '#137a13'); // mid green
      synthGrad.addColorStop(1, '#0f6b0f'); // darker bottom edge
      ctx.fillStyle = synthGrad;
      ctx.fillRect(t.left, t.top, t.playW, t.playH);

        // (Grid removed) -- plain felt surface
      
      // Central "Retro Future" Emblem
      ctx.translate(this.w/2, this.h/2);
      
      // Outer Ring
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(255, 0, 255, 0.3)'; // Neon Magenta
      ctx.beginPath();
      ctx.arc(0, 0, 90, 0, Math.PI*2);
      ctx.stroke();
      
      // Inner 8-Ball Emblem
      // Ball body
      const ballR = 50;
      const ballGrad = ctx.createRadialGradient(-15, -15, 10, 0, 0, ballR);
      ballGrad.addColorStop(0, '#8a8a8a');
      ballGrad.addColorStop(0.5, '#3a3a3a');
      ballGrad.addColorStop(1, '#151515');
      ctx.fillStyle = ballGrad;
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowBlur = 18;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 10;
      ctx.beginPath();
      ctx.arc(0, 0, ballR, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Number circle
      ctx.fillStyle = '#f5f5f5';
      ctx.beginPath();
      ctx.arc(0, 0, 18, 0, Math.PI * 2);
      ctx.fill();

      // Number
      ctx.fillStyle = '#111';
      ctx.font = 'bold 20px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('8', 0, 1);
      
      ctx.restore();

      // Baulk Line (Head String)
      ctx.save();
      ctx.globalAlpha = 0.3;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      const baulkX = t.left + (t.playW * 0.25);
      ctx.moveTo(baulkX, t.top);
      ctx.lineTo(baulkX, t.top + t.playH);
      ctx.stroke();
      ctx.restore();

      // 6. Diamonds (Aiming Sights) - 18 dots total roughly
      ctx.fillStyle = '#cfd8dc'; // Silver/Pearl
      const dSize = 3;
      // Top/Bottom (3 per segment logic simplified)
      // We place 3 dots exactly between pockets on long sides, 3 on short sides? 
      // Standard is 3 diamonds between pockets.
      const segW = t.playW / 4;
      const segH = t.playH / 4; // Not exactly standard but looks okay
      
      for(let i=1; i<4; i++){
          // Top Rail
          ctx.beginPath(); ctx.arc(t.left + segW*i, t.top - t.margin/2, dSize, 0, Math.PI*2); ctx.fill();
          // Bottom Rail
          ctx.beginPath(); ctx.arc(t.left + segW*i, t.bottom + t.margin/2, dSize, 0, Math.PI*2); ctx.fill();
      }
      // Side Rails (Short sides only need 1 or 2? Usually 3 segments = 2 dots. Let's do 3 for symmetry)
      // Actually standard pool table is 2:1. So 3 diamonds on short side? 
      // 0 -- D -- D -- D -- 0
      for(let i=1; i<4; i++){
          if(i===2) continue; // Skip middle if we want 2 dots? Or keep 3. keeping 3.
           // Left
          ctx.beginPath(); ctx.arc(t.left - t.margin/2, t.top + segH*i, dSize, 0, Math.PI*2); ctx.fill();
           // Right
          ctx.beginPath(); ctx.arc(t.right + t.margin/2, t.top + segH*i, dSize, 0, Math.PI*2); ctx.fill();
      }

      // 7. Pockets inner liners & highlights (drawn inside playing surface clip)
      for(let p of t.pockets){
        const isMiddle = (p.r === SIDE_POCKET_RADIUS);
        // inner liner (the actual hole) - dark radial gradient for depth
        const linerR = p.r - 4;
        const linerG = ctx.createRadialGradient(p.x - p.r*0.18, p.y - p.r*0.18, linerR*0.1, p.x, p.y, linerR);
        linerG.addColorStop(0, '#111');
        linerG.addColorStop(0.6, '#050505');
        linerG.addColorStop(1, '#000');
        ctx.beginPath();
        if(isMiddle && p.y === t.top){
          ctx.arc(p.x, p.y, linerR, Math.PI, 0);
          ctx.lineTo(p.x + linerR, p.y);
          ctx.lineTo(p.x - linerR, p.y);
        } else if(isMiddle && p.y === t.bottom){
          ctx.arc(p.x, p.y, linerR, 0, Math.PI);
          ctx.lineTo(p.x - linerR, p.y);
          ctx.lineTo(p.x + linerR, p.y);
        } else {
          ctx.arc(p.x, p.y, linerR, 0, Math.PI*2);
        }
        ctx.closePath();
        // leather inner rim stroke for depth
        ctx.save();
        ctx.lineWidth = 6;
        ctx.strokeStyle = '#1b0f0a';
        ctx.stroke();
        ctx.restore();
        ctx.fillStyle = linerG;
        ctx.fill();

        // small inner highlight / bevel to suggest leather catch
        ctx.beginPath();
        const hlR = Math.max(2, Math.floor(p.r*0.32));
        ctx.arc(p.x - p.r*0.22, p.y - p.r*0.22, hlR, 0, Math.PI*2);
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        ctx.fill();
      }

      // Ball Shadows first
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      for(let b of game.balls){
        if(b.pocketed) continue;
        ctx.beginPath();
        // Shadow offset based on "light" from center
        const dx = (b.x - this.w/2) * 0.02;
        const dy = (b.y - this.h/2) * 0.02;
        ctx.arc(b.x + dx + 2, b.y + dy + 2, b.r, 0, Math.PI*2);
        ctx.fill();
      }

      // Balls
      for(let b of game.balls){
        if(b.pocketed) continue;
        this.drawBall(b);
      }
      
      // UI / Drag Line
      if(game.state === 'AIMING' || game.state === 'BALL_IN_HAND'){
         let angle = 0;
         let showPrediction = true;
         
         if(game.state === 'AIMING'){
            // If moving ball on break, don't show aim line
            if(game.isMovingCueBall) {
                showPrediction = false;
            } 
            // Determine Angle to draw
            else if(game.input.mouse.down && game.wasDown){
                // Locked Mode: Use locked angle
                angle = game.lockedAngle;
            } else {
                // Hover Mode: Use current aim angle
                angle = game.aimAngle;
            }
         } else if(game.state === 'BALL_IN_HAND'){
            // Just aim to mouse if we were aiming ball in hand? 
            // Actually ball in hand usually means placing it. No aim line needed until placed.
            showPrediction = false; 
         }

         if(showPrediction && game.state === 'AIMING'){
              const vx = Math.cos(angle);
              const vy = Math.sin(angle);

              // --- Draw Cue Stick ---
              ctx.save();
              const cueBall = game.balls[0];
              ctx.translate(cueBall.x, cueBall.y);
              ctx.rotate(angle);
              
              let stickOffset = 25; // Base distance from center of ball
              // If dragging, pull back
              if(game.input.mouse.down && game.wasDown){
                  const s = game.dragStart;
                  const m = game.input.mouse;
                  const dist = Math.sqrt(Math.pow(m.x-s.x, 2) + Math.pow(m.y-s.y, 2));
                  // Limit visual pull back to somewhat realistic range (max power = 50, but visual can vary)
                  // Reduce visual sensitivity of stick pullback to match shot sensitivity
                  stickOffset += Math.min(dist * 0.6, 150); 
              }
              
              // The stick is drawn pointing to the RIGHT (positive X), but since it hits the ball from behind,
              // and the ball moves in direction `angle`, the stick should be at negative X relative to the ball,
              // pointing towards positive X.
              
              // Move "back" along the aiming line
              ctx.translate(-stickOffset, 0);
              
              // Draw Stick (oriented along X axis, tip at 0, handle at negative X)
              // Wait, if we translated -offset, 0 is closer to ball. 
              // We want the stick tip at 0 (which is now offset away from ball).
              // And the handle further left (negative).
              
              // 1. Tip (Ferrule + Chalk)
              ctx.fillStyle = '#e0e0e0'; // White Ferrule
              ctx.fillRect(-6, -3, 6, 6);
              
              ctx.fillStyle = '#3498db'; // Blue Chalk
              ctx.fillRect(-2, -3, 2, 6); // Just the very tip
              
              // 2. Shaft (Tapered)
              const stickLength = 400;
              const tipRadius = 3;
              const buttRadius = 6;
              
              const stickGrad = ctx.createLinearGradient(-6, 0, -6 - stickLength, 0);
              stickGrad.addColorStop(0, '#f0d0a0'); // Maple
              stickGrad.addColorStop(1, '#5d4037'); // Dark wood
              
              ctx.fillStyle = stickGrad;
              ctx.beginPath();
              ctx.moveTo(-6, -tipRadius);
              ctx.lineTo(-6 - stickLength, -buttRadius);
              ctx.lineTo(-6 - stickLength, buttRadius);
              ctx.lineTo(-6, tipRadius);
              ctx.fill();

              // 3. Decorations (Handle Grip / Inlays)
              ctx.fillStyle = '#222';
              ctx.fillRect(-6 - stickLength + 10, -buttRadius, 120, buttRadius*2); // Grip
              
              ctx.restore();
              // ---------------------

              // Draw Power Indicator only if dragging
              if(game.input.mouse.down && game.wasDown){
                 const s = game.dragStart;
                 const m = game.input.mouse;
                 const dist = Math.sqrt(Math.pow(m.x-s.x, 2) + Math.pow(m.y-s.y, 2));
                 
                 // Draw Power Bar near cue ball
                 ctx.fillStyle = 'rgba(255, 255, 0, 0.5)';
                 const barW = 60;
                 const barH = 6;
                 // Match reduced shot sensitivity: make power bar less sensitive to drag
                 const fill = Math.min(dist / 300, 1.0); // Visual scale
                 const cx = game.balls[0].x - barW/2;
                 const cy = game.balls[0].y + 25;
                 
                 ctx.fillRect(cx, cy, barW, barH);
                 ctx.fillStyle = (fill > 0.8 ? 'red' : (fill > 0.5 ? 'orange' : 'lime'));
                 ctx.fillRect(cx, cy, barW * fill, barH);
              }

              // --- Prediction Logic ---
              // Find first hit
              const cue = game.balls[0];
              let closestT = Infinity;
              let closestBall = null;
              
              for(let b of game.balls){
                if(b.id === 0 || b.pocketed) continue;
                
                // Ray circle intersection where radius is sum of both (20)
                // L = Center - Origin
                const Lx = b.x - cue.x;
                const Ly = b.y - cue.y;
                // tca = L . D
                const tca = Lx*vx + Ly*vy;
                if(tca < 0) continue; // Behind
                
                // d2 = L.L - tca*tca
                const d2 = (Lx*Lx + Ly*Ly) - (tca*tca);
                const rSum = cue.r + b.r;
                if(d2 > rSum*rSum) continue; // Miss
                
                const thc = Math.sqrt(rSum*rSum - d2);
                const t0 = tca - thc;
                
                if(t0 < closestT && t0 > 0){
                   closestT = t0;
                   closestBall = b;
                }
              }

              // Validate Target Color
              let headColor = 'white';
              if(closestBall && !game.openTable){
                 const myGroup = game.groups[game.turn];
                 if(myGroup){
                    // Wrong group or 8 ball too early
                    if(closestBall.type !== myGroup && closestBall.type !== 'EIGHT'){
                        headColor = '#ff3333';
                    } else if (closestBall.type === 'EIGHT'){
                        const myBalls = game.balls.filter(b => !b.pocketed && b.type === myGroup);
                        if(myBalls.length > 0) headColor = '#ff3333';
                    }
                 }
              }

              // Draw Arrow
              ctx.beginPath();
              ctx.shadowBlur = 10;
              ctx.shadowColor = headColor;
              ctx.strokeStyle = headColor;
              ctx.lineWidth = 4;
              ctx.lineCap = 'round';
              
              // Arrow Shaft
              const arrowLen = 150; // Fixed visual length for aim
              const startX = game.balls[0].x;
              const startY = game.balls[0].y;
              const endX = startX + Math.cos(angle) * arrowLen;
              const endY = startY + Math.sin(angle) * arrowLen;
              
              ctx.moveTo(startX, startY);
              ctx.lineTo(endX, endY);
              ctx.stroke();

              // Arrow Head
              const headLen = 15;
              ctx.beginPath();
              ctx.strokeStyle = headColor;
              ctx.moveTo(endX, endY);
              ctx.lineTo(endX - headLen * Math.cos(angle - Math.PI/6), endY - headLen * Math.sin(angle - Math.PI/6));
              ctx.moveTo(endX, endY);
              ctx.lineTo(endX - headLen * Math.cos(angle + Math.PI/6), endY - headLen * Math.sin(angle + Math.PI/6));
              ctx.stroke();
              ctx.shadowBlur = 0;
              
              // Draw Prediction Line
              ctx.beginPath();
              ctx.strokeStyle = 'rgba(255,255,255,0.08)';
              ctx.lineWidth = 3;
              ctx.moveTo(endX, endY);
              
              const tableFar = 2000;
              let hitX = cue.x + vx * tableFar;
              let hitY = cue.y + vy * tableFar;
              
                if(closestBall){
                  hitX = cue.x + vx * closestT;
                  hitY = cue.y + vy * closestT;
                 
                  ctx.lineTo(hitX, hitY);
                  ctx.stroke();
                 
                 // Draw Ghost Ball
                 ctx.setLineDash([]);
                 ctx.beginPath();
                 ctx.strokeStyle = 'rgba(255,255,255,0.8)';
                 ctx.lineWidth = 1;
                 ctx.arc(hitX, hitY, BALL_RADIUS, 0, Math.PI*2);
                 ctx.stroke();
                 
                 // Show collision result tangents
                 // Normal
                 const nx = (closestBall.x - hitX); // Vector from Ghost to Object
                 const ny = (closestBall.y - hitY);
                 const nLen = Math.hypot(nx, ny);
                 const unx = nx / nLen;
                 const uny = ny / nLen;
                 
                 // Tangent (Cue ball direction after hit) - 90 deg 
                 const tx = -uny; 
                 const ty = unx;
                 
                 // Tangent Line (Cue Exit)
                 ctx.beginPath();
                 ctx.strokeStyle = 'white';
                 ctx.lineWidth = 2;
                 ctx.moveTo(hitX, hitY);
                 ctx.lineTo(hitX + tx * 60, hitY + ty * 60); // Arbitrary length
                 ctx.stroke();
                 
                 // Normal Line (Object Ball Exit)
                 ctx.beginPath();
                 ctx.strokeStyle = closestBall.color; // Use ball color
                 ctx.moveTo(closestBall.x, closestBall.y);
                 ctx.lineTo(closestBall.x + unx * 60, closestBall.y + uny * 60);
                 ctx.stroke();
                 
                } else {
                  ctx.lineTo(hitX, hitY); // Just draw to infinity (or table edge)
                  ctx.stroke();
                }
              
              ctx.setLineDash([]);
             } else if (game.state === 'BALL_IN_HAND') {
            // Draw ghost cue
            const m = game.input.mouse;
            ctx.globalAlpha = 0.5;
            this.drawBall({id:0, x:clamp(m.x, t.left+BALL_RADIUS, t.right-BALL_RADIUS), y:clamp(m.y, t.top+BALL_RADIUS, t.bottom-BALL_RADIUS), r:BALL_RADIUS, color:'#fff'});
            ctx.globalAlpha = 1.0;
         }
      }

      // Draw pocket wood rims on top so they are never visually clipped
      for(let p of t.pockets){
        const isMiddle = (p.r === SIDE_POCKET_RADIUS);
        ctx.save();
        ctx.beginPath();
        if(isMiddle && p.y === t.top){
          ctx.arc(p.x, p.y, p.r + 6, Math.PI, 0); // bottom semicircle rim
        } else if(isMiddle && p.y === t.bottom){
          ctx.arc(p.x, p.y, p.r + 6, 0, Math.PI); // top semicircle rim
        } else {
          ctx.arc(p.x, p.y, p.r + 6, 0, Math.PI*2); // corner rim
        }
        ctx.closePath();
        const rimG = ctx.createLinearGradient(p.x - (p.r+8), p.y - (p.r+8), p.x + (p.r+8), p.y + (p.r+8));
        rimG.addColorStop(0, '#6b3b2b');
        rimG.addColorStop(0.5, '#3c1f15');
        rimG.addColorStop(1, '#6b3b2b');
        ctx.fillStyle = rimG;
        ctx.fill();

        // subtle outer stroke
        ctx.beginPath();
        if(isMiddle && (p.y === t.top || p.y === t.bottom)){
          ctx.arc(p.x, p.y, p.r + 6, (p.y===t.top?Math.PI:0), (p.y===t.top?0:Math.PI));
        } else {
          ctx.arc(p.x, p.y, p.r + 6, 0, Math.PI*2);
        }
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.lineWidth = 2.5;
        ctx.stroke();
        ctx.restore();
      }

      if(this.debug){
        ctx.fillStyle = 'lime';
        ctx.font = '12px monospace';
        ctx.fillText("States: " + game.state, 10, 20);
        ctx.fillText("Events: " + JSON.stringify(game.physics.events), 10, 40);
      }
    }

    roundRect(ctx, x, y, w, h, r) {
      if (w < 2 * r) r = w / 2;
      if (h < 2 * r) r = h / 2;
      ctx.beginPath();
      ctx.moveTo(x+r, y);
      ctx.arcTo(x+w, y,   x+w, y+h, r);
      ctx.arcTo(x+w, y+h, x,   y+h, r);
      ctx.arcTo(x,   y+h, x,   y,   r);
      ctx.arcTo(x,   y,   x+w, y,   r);
      ctx.closePath();
    }

    drawBall(b){
      const ctx = this.ctx;
      const isStripe = b.id > 8;
      const rot = b.rotation || {x:0, y:0};
      
      const r = b.r;
      const lightX = -r * 0.4;
      const lightY = -r * 0.4;

      ctx.save();
      ctx.translate(b.x, b.y);

      // 0. Drop Shadow 
      ctx.save();
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.arc(r*0.2, r*0.2, r, 0, Math.PI*2);
      ctx.fill();
      ctx.restore();

      // Main Ball Clip
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI*2);
      ctx.clip();

      // --- 1. ROTATING TEXTURE LAYER ---
      ctx.save();
      
      // Calculate texture offset based on rotation
      const offsetX = Math.sin(rot.y) * (r * 0.8); 
      const offsetY = Math.sin(rot.x) * (r * 0.8);
      
      ctx.translate(offsetX, offsetY);

      // BASE COLORS (Flat, no shading yet)
      if(!isStripe && b.id !== 0){
         // SOLID BALL
         ctx.fillStyle = b.color;
         ctx.fillRect(-r*10, -r*10, r*20, r*20);
      } else {
         // WHITE / STRIPE / CUE
         ctx.fillStyle = '#fffff0'; // Solid Ivory
         ctx.fillRect(-r*10, -r*10, r*20, r*20);
         
         if(isStripe){
             // Draw Stripe
             ctx.fillStyle = b.color;
             ctx.fillRect(-r*0.6, -r*10, r*1.2, r*20);
         }
      }

      // Number Circle 
      if(b.id !== 0){
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        ctx.beginPath();
        ctx.arc(0, 0, r*0.45, 0, Math.PI*2); 
        ctx.fill();
        
        ctx.strokeStyle = '#ddd';
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.fillStyle = '#000';
        const fontSize = Math.floor(r * 0.5);
        ctx.font = `bold ${fontSize}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(b.id, 0, fontSize*0.1);
        
        if(b.id === 6 || b.id === 9){
            ctx.beginPath();
            ctx.moveTo(-r*0.15, r*0.25);
            ctx.lineTo(r*0.15, r*0.25);
            ctx.strokeStyle = '#000';
            ctx.lineWidth = 1.5;
            ctx.stroke();
        }
      } else {
         // Cue Ball Dot
         ctx.fillStyle = '#d00';
         ctx.beginPath();
         // A small red circle slightly off center to show rotation if we had it
         ctx.arc(r*0.3, r*0.1, 2, 0, Math.PI*2);
         ctx.fill();
      }

      ctx.restore(); // -- END TEXTURE TRANSLATION -- 

      // --- 2. STATIC SHADING LAYER (Fixed to light source) ---
      // This applies the spherical look *over* the moving texture
      // Gradient must be larger than ball clip to avoid hard edges
      const sphereGrad = ctx.createRadialGradient(lightX, lightY, r*0.1, 0, 0, r*1.2); 
      // Center: Transparent (show color)
      // Edge: Dark shadow
      sphereGrad.addColorStop(0, 'rgba(255,255,255,0.05)'); 
      sphereGrad.addColorStop(0.5, 'rgba(0,0,0,0)');
      sphereGrad.addColorStop(1, 'rgba(0,0,0,0.5)'); // Rim shadow
      
      ctx.fillStyle = sphereGrad;
      ctx.beginPath();
      // Draw rect over whole clip
      ctx.fillRect(-r, -r, r*2, r*2);

      // --- 3. GLARE ---
      const glare = ctx.createRadialGradient(lightX - r*0.1, lightY - r*0.1, 0.5, lightX - r*0.1, lightY - r*0.1, r*0.4);
      glare.addColorStop(0, 'rgba(255,255,255,0.9)');
      glare.addColorStop(0.2, 'rgba(255,255,255,0.4)');
      glare.addColorStop(1, 'rgba(255,255,255,0)');
      
      ctx.fillStyle = glare;
      ctx.beginPath();
      ctx.arc(lightX, lightY, r*0.5, 0, Math.PI*2);
      ctx.fill();

      ctx.restore();
    }
  }

  // Start
  window.addEventListener('load', () => new Game());

})();
