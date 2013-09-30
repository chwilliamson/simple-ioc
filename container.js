module.exports = function( log ) {
	var components = {},
		waitingId, waitingTs, waiting = [], waitingWarningTime = 2000,
		reservedDependencies = [ 'readyCallback', 'iocCallback', 'iocParentName' ],
	isReservedDependency = function( name ) {
		return reservedDependencies.indexOf( name ) >= 0;
	},
	register = function( name, fn, singleton ) {
		log.trace( 'registering', name );
		if( components[ name ] )
			log.fatal( 'Same name was already registered', name );
		else {
			components[ name ] = {
				fn: fn,
				singleton: singleton,
				resolved: false
			};
			var dependencies = getDependencies( name );
			components[ name ].dependencies = dependencies;
			if( ( dependencies.indexOf( 'iocParentName' ) >= 0 ) && singleton ) {
				log.error( 'Cannot register a component as singleton if it has iocParentName as dependency, switching to transient', name );
				components[ name ].singleton = false;
			}
			var unusedDependencies = [];
			dependencies.forEach( function( dependency ) {
				if( fn.toString().split( dependency ).length <= 2 )
					unusedDependencies.push( dependency );
			} );
			if( unusedDependencies.length > 0 )
				log.warning( 'Possible unused dependencies for', name + '(' + unusedDependencies.join( ', ' ) + ')' );
			log.debug( 'registered', name );
		}
	},
	load = function( name, instance ) {
		if( components[ name ] )
			log.fatal( 'Same name was already registered', name );
		else {
			components[ name ] = {
				instance: instance,
				resolved: true
			};
			log.info( 'loaded', name );
		}
	},
	getDependencies = function( name, fn ) {
		var component = fn ? { fn: fn } : components[ name ];
		if( component ) {
			if( component.instance )
				return [];
			else {
				var dependencies = [];
				if( typeof( component.fn ) == 'function' ) {
					try {
						component.fn.toString()
							.replace( /\n/g, ' ' )
							.match( /function\s+\w*\s*\((.*?)\)/ )[1].split( /\s*,\s*/ )
							.map( function( parameter ) { return parameter.trim(); } )
							.forEach( function( parameter ) {
								if( parameter.length > 0 )
									dependencies.push( parameter );
							} );
						log.trace( 'dependencies for ' + name, dependencies.join( ', ' ) );
						return dependencies;
					}
					catch( ex ) {
						log.fatal( 'function malformatted', name );
					}
				}
				else
					log.fatal( 'getDependencies failed, function not registered', name );
			}
		}
		else
			log.fatal( 'getDependencies failed, not registered', name );
	},
	getUnresolvableDependencies = function( name, parents ) {
		parents = parents || [ name ];
		if( !components[ name ] )
			return parents;
		var dependencies = getDependencies( name );
		for( var i = 0 ; i < dependencies.length ; i++ ) {
			var dependency = dependencies[ i ];
			if( !isReservedDependency( dependency ) )
				if( parents.indexOf( dependency ) >= 0 )
					log.fatal( 'Cyclic dependency', parents.concat( [ dependency ] ).join( ' -> ' ) );
				else {
					var chain = getUnresolvableDependencies( dependency, parents.concat( [ dependency ] ) );
					if( chain )
						return chain;
				}
		}
		return undefined;
	},
	resolveDependencies = function( name, parentName, dependencies, iocCallback, callback, resolved ) {
		resolved = resolved || [];
		if( dependencies.length > 0 ) {
			var dependency = dependencies[ 0 ], remaining = dependencies.slice( 1 );
			if( isReservedDependency( dependency ) ) {
				if( dependency == 'iocParentName' ) {
					resolveDependencies( name, undefined, remaining, iocCallback, callback, resolved.concat( [ parentName ] ) );
				}
				else // readyCallback, parentName
					resolveDependencies( name, parentName, remaining, undefined, callback, resolved.concat( [ iocCallback ] ) );
			}
			else
				resolve( dependency, function( instance ) {
					resolveDependencies( name, parentName, remaining, iocCallback, callback, resolved.concat( [ instance ] ) );
				}, name );
		}
		else {
			callback( resolved, iocCallback );
		}
	},
	resolve = function( name, callback, parentName ) {
		var component = components[ name ];
		if ( component === undefined )
			log.fatal( 'Unresolvable, not registered', name );
		else if( component.instance )
			callback( component.instance );
		else {
			log.debug( 'resolving', name );
			startWaiting( name );
			resolveDependencies( name, parentName, component.dependencies, function( instance ) {
				if( component.singleton )
					log.info( instance ? 'resolved singleton' : 'only injected singleton', name );
				else
					log.debug( instance ? 'resolved transient' : 'only injected transient', name );
				component.resolved = true;
				if( component.singleton )
					component.instance = instance;
				stopWaiting( name );
				callback( instance );
			}, function( resolvedDependencies, iocCallback ) {
				log.trace( 'injecting', name + ' (' + component.dependencies.join( ', ' ) + ')' );
				if( iocCallback )
					iocCallback( component.fn.apply( this, resolvedDependencies ) );
				else
					component.fn.apply( this, resolvedDependencies );
			} );
		}
	},
	reportWaiting = function() {
		if( waitingId )
			clearInterval( waitingId );
		waitingId = setInterval( function() {
			var ms = new Date().getTime() - waitingTs;
			log.warning( 'Waiting for callback from', waiting[ waiting.length - 1 ] + ' (' + ( ms / 1000 ) + ' s)' );
		}, waitingWarningTime );
	},
	startWaiting = function( name ) {
		waiting.push( name );
		waitingTs = new Date().getTime();
		reportWaiting();
	},
	stopWaiting = function () {
		clearInterval( waitingId );
		waiting.pop();
		waitingId = undefined;
		if( waiting.length > 0 )
			reportWaiting();
	},
	setWaitingWarningTime = function( milliseconds ) {
		waitingWarningTime = milliseconds;
	},
	inject = function( fn ) {
		log.debug( 'injecting anonymous function', undefined );
		resolveDependencies( 'anonymous', undefined, getDependencies( 'anonymous function', fn ), function() {}, function( resolvedDependencies ) {
			fn.apply( this, resolvedDependencies );
		} );
	},
	getNextResolvable = function() {
		var tries = [];
		for( var name in components ) {
			var component = components[ name ];
			if( !component.resolved && component.singleton ) {
				var unresolvableDependencies = getUnresolvableDependencies( name );
				if( unresolvableDependencies ) {
					var text = unresolvableDependencies.join( ' -> ' );
					for( var i = 0 ; ( i < tries.length ) && text ; i++ )
						if( tries[ i ].indexOf( text ) >= 0 )
							text = undefined;
						else if( text.indexOf( tries[ i ] ) >= 0 ) {
							tries[ i ] = text;
							text = undefined;
						}
					if( text )
						tries.push( text );
				}
				else
					return name;
			}
		}
		if( tries.length > 0 )
			log.fatal( 'Unresolvable components', '\n ' + tries.join( '\n ' ) );
	},
	resolveAll = function( callback ) {
		log.trace( 'Resolving all', undefined );
		var nextResolvable = getNextResolvable();
		if( nextResolvable )
			resolve( nextResolvable, function() {
				resolveAll( callback );
			} );
		else {
			log.debug( 'All resolved', undefined );
			setImmediate( callback );
		}
	},
	reset = function() {
		components = {};
	},
	setLogger = function( logger ) {
		log = logger;
	};
	return {
		register: register,
		load: load,
		resolve: resolve,
		resolveAll: resolveAll,
		inject: inject,
		reset: reset,
		setWaitingWarningTime: setWaitingWarningTime,
		setLogger: setLogger
	};
};
