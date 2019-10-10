//Load required classes.
const { Servers } = require('alta-jsapi');
const { WebsocketBot } = require('att-bot-core');
const { BasicWrapper } = require('att-websockets');
const Discord = require('discord.js');
const moment = require('moment');
const fs = require('fs');

//Local classes
const Player = require('./src/player.js');
const Subscriptions = require('./src/subscriptions.js');

//Load information from credentials and config
const { username, password, botToken } = require("./credentials");
const { targetServers, discordPrefix, discordChannels } = require("./config");
const { playerFile } = require("./files");


//NeDB
var Datastore = require('nedb');
var players = new Datastore({ filename : 'data/players.db', autoload: true });
var kills = new Datastore({ filename : 'data/playerkills.db', autoload: true });
var chunkHistory = new Datastore({ filename : 'data/chunkhistory.db', autoload: true });
players.ensureIndex({ fieldName: 'id', unique: 'true' });
players.persistence.setAutocompactionInterval( 129600 );

var playerLocations = {};
var botConnection;

//Some utility helper functions and prototypes
function ts()
{ 
    return "["+ moment().format("h:mm:ss A") +"] " 
}

function strrep( str, n )
{
    if ( n < 1 ) return '';
    var result = str;
    while( n-- > 0 )
    {
        result += str;
    }
    return result;
}

function loadJSON( file )
{
    try {
        fs.accessSync( file );
        var jsonObj = JSON.parse( fs.readFileSync( file ));
        console.log("Loaded data from: "+ file );
        return jsonObj;
    } catch (e) {
        console.log( "Unable to load data from file: "+ file +", "+ e );
        return {};
    }
}

function saveJSON( file, obj )
{
    try {
        fs.writeFileSync( file, JSON.stringify( obj, null, 4 ));
        console.log( "Saved data to file: "+ file );
    } catch (e) {
        console.log( "Unable to save to file: "+ file +", "+ e );
    }
}

//Command list
const commands = {
    'ping': (message, args) =>
    {
        message.channel.send("pong");
    },

    'where': (message, args) =>
    {
        while ( args.length && args[0].toLowerCase() === "is" )
        {
            argv = args.shift();
        }

        
        var username = args.join(' ');

        if ( username && !!playerLocations[username] )
        {
            message.channel.send(username +" is at "+ playerLocations[username]);
        } else if ( username ){
            message.channel.send("No location known for "+ username);
        }
    },

    'who': (message, args) =>
    {
        while( args.length && args[0].toLowerCase() === "is" )
        {
            argv = args.shift();
        }

        var username = args.join(' ');
        players.findOne({ username: username }, function( err, player ) {
            if ( err ) 
            {
                console.log( err );
            } else {
                if ( !player )
                {
                    message.channel.send('```'+ "Unknown user: "+ username +'```');
                } else if ( !player.bio ) { 
                    message.channel.send('```'+ username +" does not have a bio"+ '```');
                } else {
                    message.channel.send('```'+ username +" is "+ player.bio +'```');
                }
            }
        });
    },

    'bio': (message, args) =>
    {
        var username = message.author.username;
        players.findOne({ username: username }, function( err, player ) {
            if ( err ) {
                console.log( err );
            }
            console.log( player );
            if ( player )
            {
                while ( args[0] === username || args[0] === "is" )
                {
                    args.shift();
                }
                var bio = args.join(' ');
            } else {            
                username = args.shift();
                var bio = args.join(' ');
            }
            if ( player )
            {
                players.update({ id: player.id }, { $set: { bio: bio } }, {}, function( err, numReplaced ) {
                    if ( err )
                    {
                        console.log( err );
                    } else {
                        message.channel.send('```'+ username +" is "+ bio +'```');
                    }
                });
            } else {
                message.channel.send('```'+ "Unknown user: "+ username +'```');
            }
        });
    },

    'servers': async function (message, args)
    {
        var servers = await Servers.getOnline();

        if ( !!servers )
        {
            var longest = 0;
            for( var i in servers )
            {
                if ( servers[i].name.length > longest )
                {
                    longest = servers[i].name.length;
                }
            }

            var serverNameLen = longest + 1;
            var listTable =  "| Servers"+ strrep(' ', (serverNameLen - 7)) +"| Players\n";
                listTable += "|"+ strrep('-', (serverNameLen + 1) ) +"|---------\n";
            for ( var i in servers )
            {
                listTable += "| "+ servers[i].name + strrep(' ', ( serverNameLen - servers[i].name.length )) +"| "+ servers[i].online_players.length +"\n";
            }
        
            message.channel.send( '```'+ listTable +'```' );
                   
        } else {
            message.channel.send("No servers appear to be online, perhaps it's patch day?");
        }
    },

    'players': async function (message, args)
    {
        var servers = await Servers.getOnline();
        var listTable = '';

        while ( args.length && ( args[0].toLowerCase() === "online" || args[0].toLowerCase() === "in" || args[0].toLowerCase() === "on" ) )
        {
            args.shift();
        }

        var mustMatch = args.join(' ');

        for( var i in servers )
        {
            if ( mustMatch )
            {
                var re = new RegExp( mustMatch, 'ig' );
                if ( !servers[i].name.match( re ) )
                {
                    continue;
                }
            }
            listTable += "| "+ servers[i].name +"\n";
            listTable += "|"+ strrep('-', (servers[i].name.length + 1)) +"\n";
                    
            var pOnline = servers[i].online_players;
            for( var n in pOnline )
            {
                listTable += "| "+ pOnline[n].username +"\n";
            }
            listTable += "\n";
        }

        if ( listTable === '' )
        {
            if ( mustMatch )
            {
                message.channel.send('```No server found matching "'+ mustMatch +'"```');
            } else {
                message.channel.send('```No servers were found online, is it patch day?```');
            }
        } else {
            message.channel.send('```'+ listTable +'```');
        }
    },

    'zone': async function (message, args)
    {
        switch( args.shift() )
        {
            case 'history':
                var chunkName = args.join(' ');
                players.find({}, function( err, playerList ) {
                    chunkHistory.find({ chunk: chunkName }).sort({ ts: -1 }).exec( function( err, chunklist ) {
                        if ( err )
                        {
                            console.log( err );
                        } else if ( !chunklist ) {
                            message.channel.send('```'+ "No history for zone '"+ chunkName +"'"+ '```');
                        } else {
                            var response  = "| Players who have visited zone '"+ chunkName +"'\n";
                                response += "|--------------------------------"+ strrep( '-', chunkName.length ) +"-\n";
                            chunklist.forEach( function( ichunk ) {
                                player = playerList.find( x => x.id === ichunk.player );
                                response += "|["+ moment( ichunk.ts ).format("YYYY/MM/DD HH:mm:ss") +"] "+ player.username +"\n";
                            });
                            message.channel.send('```'+ response +'```');   
                        }
                    });
                });
            break;
        }
    },       

    'player' : async function ( message, args )
    {
        switch( args.shift() )
        {
            case 'path':
                // Return known history of player movements
                var username = args.join(' ');
                players.findOne({ username: username }, function( err, player ) {
                    if ( err ) 
                    {
                        message.channel.send('```'+ "No player data found for "+ username +'```');
                    } else {
                        chunkHistory.find({ player: player.id }).sort({ ts: -1 }).exec( function ( err, chunklist ) {
                            if ( err )
                            {
                                console.log( err );
                            } else if ( !!chunklist ) {
                                var response  = '| Path History for '+ username +"\n";
                                    response += '|------------------'+ strrep('-', username.length+1) +"\n";
                                for ( var i in chunklist ) {
                                    var elem = chunklist[i];
                                    response += "|["+ moment( elem.ts ).format( "YYYY/MM/DD HH:mm:ss" ) +"] "+ elem.chunk +"\n";
                                }
                                message.channel.send('```'+ response +'```');
                            } else {
                                message.channel.send('```'+ "No player data found for "+ username +'```');
                            }
                        });
                    }
                });
            break;
            
        }
    }
}



//Run the program
main();

async function main()
{
    console.log( ts() + "bot is starting" );

    // Players in database
    players.find({}).exec( function( err, docs ) { console.log( docs );} );
    console.log( players );

    //Connect to discord
    const discord = new Discord.Client();
    await new Promise( resolve =>
    {
        discord.on('ready', resolve);
        discord.login(botToken);
    });
    
    //Discord command and message management (todo: move to own lib)
    discord.on('message', message =>
    {
        if ( message.content.length > 0 && message.content.startsWith( discordPrefix ) )
        {
            var tmessage = message.content.substring(discordPrefix.length).trim();
            var args = tmessage.split(' ');

            if ( args && args.length >= 1 )
            {
                var command = args.shift();
                var commandFunction = commands[command];
                if (!!commandFunction)
                {
                    commandFunction(message, args, tmessage);
                }
            }
        }
    });
                    

    //Alta Login
    const bot = new WebsocketBot();
    //Use a hashed password, SHA512
    await bot.loginWithHash(username, password);
    var subs = new Subscriptions( discordChannels, players, kills, chunkHistory );

    //When any of the 'targetServers' are available, a connection is automatically created.
    await bot.run(test => targetServers.includes(test.id), async (server, connection) =>
    {
        console.log( server );
        console.log( connection );

        //By default, connections simply receive commands, and emit messages.
        //To add callback support for events, we'll use the "BasicWrapper" provided by att-websockets.
        var wrapper = new BasicWrapper(connection);
        
        botConnection = 
        {
            "connection" : connection,
            "wrapper" : wrapper
        }

        console.log( ts() +"loading inital players" );
        for ( var i in server.online_players )
        {
            let oplayer = server.online_players[i];
            subs.PlayerJoined( discord, { "user": { "id": oplayer.id, "username": oplayer.username } });
        }

        // Subscriptions
        await wrapper.subscribe("PlayerJoined", data => { subs.PlayerJoined( discord, data ) }); 
        await wrapper.subscribe("PlayerLeft", data => { subs.PlayerLeft( discord, data ); });
        await wrapper.subscribe("PlayerKilled", data => { subs.PlayerKilled( discord, data ); });
        await wrapper.subscribe("TradeDeckUsed", data => { subs.TradeDeckUsed( discord, data ); });
        await wrapper.subscribe("CreatureKilled", data => { subs.CreatureKilled( discord, data ); });
        await wrapper.subscribe("PlayerMovedChunk", data => { subs.PlayerMovedChunk( discord, data ); });

        // this one is kinda spammy as it covers all automatic spawns, including inanimate objects
        //await wrapper.subscribe("CreatureSpawned", data => { logMessage["CreatureSpawned"]( discord, data ); });

/*
        await wrapper.subscribe(" PlayerMovedChunk", data =>
        { 
            var activePlayer = arr.find( o => o.id === data.user.id );
            //Log out the players movement
            logMessage["PlayerMovedChunk"]( discord, data );
            //playerLocations[data.player.username] = data.newChunk;
            if ( !chunkHistory[ data.newChunk ] )
            {
                chunkHistory[ data.newChunk ] = [];
            }
            chunkHistory[ data.newChunk ].unshift( { "ts": moment(), "username": data.player.username } );
        });
*/
    });
    // end bot.run()

}
