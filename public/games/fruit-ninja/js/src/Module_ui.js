(function() {
	
	var ui_newGameUpdate=function()
	{
		this.rotation+=0.01;
	};
	
	showStartGameUI=function()
	{
		 gameState=GAME_READY;
		
		 ui_gameTitle = particleSystem.createParticle(SPP.SpriteImage);
		 ui_gameTitle.regX= ui_gameTitle.regY=0;
		 ui_gameTitle.init(0,-assetsManager.gametitle.height,Infinity,assetsManager.gametitle,topContext);
		 TweenLite.to(ui_gameTitle.position,0.5,{y:0});
		 
		ui_newGame = particleSystem.createParticle(SPP.SpriteImage);
		ui_newGame.init(gameWidth*0.618,gameHeight*0.618,Infinity,assetsManager.newgame,topContext);
		ui_newGame.scale=5;
		ui_newGame.alpha=0;
		ui_newGame.onUpdate=ui_newGameUpdate;
		TweenLite.to(ui_newGame,0.8,{scale:1,alpha:1,ease :Back.easeOut});

		ui_startFruit = fruitSystem.createParticle(FruitGame.Fruit);
		ui_startFruit.addEventListener("dead",startGame);
		var textureObj=assetsManager.getRandomFruit();
		ui_startFruit.init(gameWidth*0.618,gameHeight*0.618,Infinity,textureObj.w,assetsManager.shadow,topContext);
		ui_startFruit.rotationStep=-0.02;
		ui_startFruit.scale=0;
		ui_startFruit.alpha=0;
		ui_startFruit.textureObj=textureObj;
		TweenLite.to(ui_startFruit,1,{scale:1,alpha:1,ease :Back.easeOut});
	};
	
    hideStartGameUI=function()
	{
		ui_startFruit.removeEventListener("dead",startGame);
		TweenLite.to(ui_gameTitle.position,0.8,{y:-assetsManager.gametitle.height});
		TweenLite.to(ui_newGame,0.8,{scale:8,alpha:0,onComplete:function()
		{
			ui_gameTitle.life=0;
		    ui_newGame.life=0;
	    }});
	};

	showScoreTextUI=function()
	{
		if(gameState==GAME_READY)
		{
			// OFFCOMFRT branding on title screen
			bottomContext.save();
			bottomContext.globalAlpha=0.12;
			bottomContext.font="bold 14px 'Helvetica Neue', Arial, sans-serif";
			bottomContext.fillStyle="#ffffff";
			bottomContext.textAlign="right";
			bottomContext.letterSpacing="3px";
			bottomContext.fillText("OFFCOMFRT",gameWidth-16,gameHeight-20);
			bottomContext.globalAlpha=0.06;
			bottomContext.font="10px 'Helvetica Neue', Arial, sans-serif";
			bottomContext.fillText("outside comfort",gameWidth-16,gameHeight-8);
			bottomContext.restore();
			return;
		}
		bottomContext.font="36px Courier-Bold";
		bottomContext.fillText(" "+score,24,6);
		bottomContext.font="14px Courier-Bold";
		bottomContext.fillText("Best:"+storage.highScore,13,50);
		
		// Subtle OFFCOMFRT watermark during gameplay
		bottomContext.save();
		bottomContext.globalAlpha=0.04;
		bottomContext.font="bold 10px 'Helvetica Neue', Arial, sans-serif";
		bottomContext.fillStyle="#ffffff";
		bottomContext.textAlign="right";
		bottomContext.letterSpacing="2px";
		bottomContext.fillText("OFFCOMFRT",gameWidth-12,gameHeight-10);
		bottomContext.restore();
	};

	showScoreUI=function()
	{
		ui_scoreIcon = particleSystem.createParticle(SPP.SpriteImage);
		ui_scoreIcon.regX=ui_scoreIcon.regY=0;
		ui_scoreIcon.init(10,10,Infinity,assetsManager.score,bottomContext);

		ui_gameLife = particleSystem.createParticle(SPP.SpriteImage);
		ui_gameLife.regX=1;
		ui_gameLife.regY=0;
		ui_gameLife.init(gameWidth,8,Infinity,ui_gamelifeTexture,bottomContext);
	};
	
    hideScoreUI=function()
	{
		if(ui_scoreIcon!=undefined)
		{
			ui_scoreIcon.life=0;
		}
		if(ui_gameLife!=undefined)
		{
			ui_gameLife.life=0;
		}
	};
	
	showGameoverUI=function()
	{
		ui_gameOver = particleSystem.createParticle(SPP.SpriteImage);
		ui_gameOver.init(gameWidth*0.5,gameHeight*0.5,Infinity,assetsManager.gameover,topContext);
		ui_gameOver.scale=0;
		TweenLite.to(ui_gameOver,0.8,{delay:2,scale:1,ease :Back.easeOut,onComplete:gameOverComplete});
		
		// OFFCOMFRT branding on game over screen
		setTimeout(function(){
			bottomContext.save();
			bottomContext.globalAlpha=0.1;
			bottomContext.font="bold 12px 'Helvetica Neue', Arial, sans-serif";
			bottomContext.fillStyle="#ffffff";
			bottomContext.textAlign="center";
			bottomContext.letterSpacing="2px";
			bottomContext.fillText("OFFCOMFRT",gameWidth/2,gameHeight-30);
			bottomContext.restore();
		},2500);
	};
	
	var gameoverUIHideComplete=function()
	{
		ui_gameOver.life=0;
		hideScoreUI();
		showStartGameUI();
	};
	hideGameoverUI=function()
	{
		TweenLite.to(ui_gameOver,0.8,{scale:0,ease :Back.easeIn,onComplete:gameoverUIHideComplete});
	};

}());