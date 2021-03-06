// This file is part of nbind, copyright (C) 2014-2016 BusFaster Ltd.
// Released under the MIT license, see LICENSE.

// This file handles creating invoker functions for Emscripten dyncalls
// wrapped in type conversions for arguments and return values.

import {setEvil, prepareNamespace} from 'emscripten-library-decorator';
import {_nbind as _globals} from './Globals';
import {_nbind as _type} from './BindingType';
import {_nbind as _callback} from './Callback';
import {_nbind as _resource} from './Resource';

// Let decorators run eval in current scope to read function source code.
setEvil((code: string) => eval(code));

export namespace _nbind {

	type Func = _globals.Func;
	type FuncList = _globals.FuncList;
	type TypeIdList = _globals.TypeIdList;

	export var getTypes: typeof _globals.getTypes;
	export var makeSignature: typeof _globals.makeSignature;

	export var callbackList: typeof _callback.callbackList;

	export var listResources: typeof _resource.listResources;
	export var resources: typeof _resource.resources;

	/** Make a list of argument names a1, a2, a3...
	  * for dynamically generating function source code. */

	function makeArgList(argCount: number) {
		return(
			Array.apply(null, Array(argCount)).map(
				(dummy: any, num: number) => ('a' + (num + 1))
			)
		);
	}

	/** Check if any type on the list requires conversion writing to C++.
	  * Mainly numbers can be passed as-is between Asm.js and JavaScript. */

	function anyNeedsWireWrite(typeList: _type.BindType[]) {
		return(typeList.reduce(
			(result: boolean, type: _type.BindType) =>
				(result || !!type.wireWrite || !!type.makeWireWrite),
			false
		));
	}

	/** Check if any type on the list requires conversion reading from C++.
	  * Mainly numbers can be passed as-is between Asm.js and JavaScript. */

	function anyNeedsWireRead(typeList: _type.BindType[]) {
		return(typeList.reduce(
			(result: boolean, type: _type.BindType) =>
				(result || !!type.wireRead || !!type.makeWireRead),
			false
		));
	}

	/** Dynamically build a function that calls an Asm.js invoker
	  * with appropriate type conversion for complicated types:
		* - Push arguments to stack.
		* - Read return value.
		* - Restore stack pointer if necessary. */

	function buildCallerFunction(
		dynCall: Func,
		ptr: number,
		num: number,
		needsWireWrite: boolean,
		prefix: string,
		returnType: _type.BindType,
		argTypeList: _type.BindType[]
	) {
		const argList = makeArgList(argTypeList.length);
		/** List of arbitrary data for type converters.
		  * Each one may read and write its own slot. */
		const convertParamList: any[] = [];
		/** Next free slot number in type converter data list. */
		let paramNum = 0;

		function makeWireRead(type: _type.BindType, expr: string) {
			if(type.makeWireRead) {
				return(type.makeWireRead(expr, convertParamList, paramNum++));
			} else if(type.wireRead) {
				convertParamList[paramNum] = type.wireRead;
				return('(convertParamList[' + (paramNum++) + '](' + expr + '))');
			} else return(expr);
		}

		function makeWireWrite(type: _type.BindType, expr: string) {
			if(type.makeWireWrite) {
				return(type.makeWireWrite(expr, convertParamList, paramNum++));
			} else if(type.wireWrite) {
				convertParamList[paramNum] = type.wireWrite;
				return('(convertParamList[' + (paramNum++) + '](' + expr + '))');
			} else return(expr);
		}

		// Build code for function call and type conversion.

		const callExpression = makeWireRead(
			returnType,
			'dynCall(' +
				[prefix].concat(argList.map(
					(name: string, index: number) => makeWireWrite(argTypeList[index], name)
				)).join(',') +
			')'
		);

		// Build code to allocate and free the stack etc. if necessary.

		const resourceSet = listResources([returnType], argTypeList);

		const sourceCode = (
			'function(' + argList.join(',') + '){' +
				resourceSet.makeOpen() +
				'var r=' + callExpression + ';' +
				resourceSet.makeClose() +
				'return r;' +
			'}'
		);

		// Use eval to allow JIT compiling the function.

		return(eval('(' + sourceCode + ')'));
	}

	/** Dynamically build a function that calls a JavaScript callback invoker
	  * with appropriate type conversion for complicated types:
		* - Read arguments from stack.
		* - Push return value.
		* - Restore stack pointer if necessary. */

	export function buildJSCallerFunction(
		returnType: _type.BindType,
		argTypeList: _type.BindType[]
	) {
		const argList = makeArgList(argTypeList.length);
		/** List of arbitrary data for type converters.
		  * Each one may read and write its own slot. */
		const convertParamList: any[] = [];
		/** Next free slot number in type converter data list. */
		let paramNum = 0;

		function makeWireRead(type: _type.BindType, expr: string) {
			if(type.makeWireRead) {
				return(type.makeWireRead(expr, convertParamList, paramNum++));
			} else if(type.wireRead) {
				convertParamList[paramNum] = type.wireRead;
				return('convertParamList[' + (paramNum++) + '](' + expr + ')');
			} else return(expr);
		}

		function makeWireWrite(type: _type.BindType, expr: string) {
			if(type.makeWireWrite) {
				return(type.makeWireWrite(expr, convertParamList, paramNum));
			} else if(type.wireWrite) {
				convertParamList[paramNum] = type.wireWrite;
				return('convertParamList[' + (paramNum++) + '](' + expr + ')');
			} else return(expr);
		}

		const callExpression = makeWireWrite(
			returnType,
			'_nbind.callbackList[num](' +
				argList.map(
					(name: string, index: number) => makeWireRead(argTypeList[index], name)
				).join(',') +
			')'
		);

		const resourceSet = listResources(argTypeList, [returnType]);

		// Let the calling C++ side handle resetting the pool (using the
		// PoolRestore class) after parsing the callback return value passed
		// through the pool.

		resourceSet.remove(_nbind.resources.pool);

		const sourceCode = (
			'function(' + ['dummy', 'num'].concat(argList).join(',') + '){' +
				resourceSet.makeOpen() +
				'var r=' + callExpression + ';' +
				resourceSet.makeClose() +
				'return r;' +
			'}'
		);

		// Use eval to allow JIT compiling the function.

		return(eval('(' + sourceCode + ')'));
	}

	/* tslint:disable:indent */

	/** Dynamically create an invoker for a JavaScript callback. */

	export function makeJSCaller(idList: TypeIdList) {
		const argCount = idList.length - 1;

		const typeList = getTypes(idList);
		const returnType = typeList[0];
		const argTypeList = typeList.slice(1);
		const needsWireRead = anyNeedsWireRead(argTypeList);
		const needsWireWrite = returnType.wireWrite || returnType.makeWireWrite;

		if(!needsWireWrite && !needsWireRead) {
			switch(argCount) {
				case 0: return(function(dummy: number, num: number) {
				                    return(callbackList[num](    )); });
				case 1: return(function(dummy: number, num: number, a1: any) {
				                    return(callbackList[num](       a1    )); });
				case 2: return(function(dummy: number, num: number, a1: any, a2: any) {
				                    return(callbackList[num](       a1,      a2    )); });
				case 3: return(function(dummy: number, num: number, a1: any, a2: any, a3: any) {
				                    return(callbackList[num](       a1,      a2,      a3    )); });
				default:
					// Function takes over 3 arguments.
					// Let's create the invoker dynamically then.
					break;
			}
		}

		return(buildJSCallerFunction(
			returnType,
			argTypeList
		));
	}

	/** Dynamically create an invoker function for calling a C++ class method. */

	export function makeMethodCaller(
		ptr: number,
		num: number,
		boundID: number,
		idList: TypeIdList
	) {
		const argCount = idList.length - 1;

		// The method invoker function adds two arguments to those of the method:
		// - Number of the method in a list of methods with identical signatures.
		// - Target object

		idList.splice(1, 0, 'uint32_t', boundID);

		const typeList = getTypes(idList);
		const returnType = typeList[0];
		const argTypeList = typeList.slice(3);
		const needsWireRead = returnType.wireRead || returnType.makeWireRead;
		const needsWireWrite = anyNeedsWireWrite(argTypeList);

		const dynCall = Module['dynCall_' + makeSignature(typeList)];

		if(!needsWireRead && !needsWireWrite) {
			// If there are only a few arguments not requiring type conversion,
			// build a simple invoker function without using eval.

			switch(argCount) {
				case 0: return(function() {return(
				        dynCall(ptr, num, this.__nbindPtr)); });
				case 1: return(function(                   a1: any) {return(
				        dynCall(ptr, num, this.__nbindPtr, a1    )); });
				case 2: return(function(                   a1: any, a2: any) {return(
				        dynCall(ptr, num, this.__nbindPtr, a1,      a2    )); });
				case 3: return(function(                   a1: any, a2: any, a3: any) {return(
				        dynCall(ptr, num, this.__nbindPtr, a1,      a2,      a3    )); });
				default:
					// Function takes over 3 arguments or needs type conversion.
					// Let's create the invoker dynamically then.
					break;
			}
		}

		return(buildCallerFunction(
			dynCall,
			ptr,
			num,
			needsWireWrite,
			'ptr,num,this.__nbindPtr',
			returnType,
			argTypeList
		));
	}

	/** Dynamically create an invoker function for calling a C++ function. */

	export function makeCaller(
		ptr: number,
		num: number,
		direct: number,
		idList: TypeIdList
	) {
		const argCount = idList.length - 1;

		const typeList = getTypes(idList);
		const returnType = typeList[0];
		const argTypeList = typeList.slice(1);
		const needsWireRead = returnType.wireRead || returnType.makeWireRead;
		const needsWireWrite = anyNeedsWireWrite(argTypeList);

		if(direct && !needsWireRead && !needsWireWrite) {
			// If there are only a few arguments not requiring type conversion,
			// build a simple invoker function without using eval.

			const dynCall = Module['dynCall_' + makeSignature(typeList)];

			switch(argCount) {
				case 0: return(() =>
				        dynCall(direct));
				case 1: return((        a1: any) =>
				        dynCall(direct, a1       ));
				case 2: return((        a1: any, a2: any) =>
				        dynCall(direct, a1,      a2       ));
				case 3: return((        a1: any, a2: any, a3: any) =>
				        dynCall(direct, a1,      a2,      a3       ));
				default:
					// Function takes over 3 arguments.
					// Let's create the invoker dynamically then.
					break;
			}

			// Input and output types don't need conversion so omit dispatcher.
			ptr = null;
		}

		let prefix: string;

		if(ptr) {
			// The function invoker adds an argument to those of the function:
			// - Number of the function in a list of functions with identical signatures.

			idList.splice(1, 0, 'uint32_t');
			prefix = 'ptr,num';
		} else {
			ptr = direct;
			prefix = 'ptr';
		}

		const dynCall = Module['dynCall_' + makeSignature(getTypes(idList))];

		return(buildCallerFunction(
			dynCall,
			ptr,
			num,
			needsWireWrite,
			prefix,
			returnType,
			argTypeList
		));
	}

	/* tslint:enable:indent */

	/** Create an overloader that can call several methods with the same name,
	  * depending on the number of arguments passed in the call. */

	export function makeOverloader(func: Func, arity: number) {
		const callerList: FuncList = [];

		function call() {
			return(callerList[arguments.length].apply(this, arguments));
		}

		(call as any).addMethod = (_func: Func, _arity: number) => {
			callerList[_arity] = _func;
		};

		(call as any).addMethod(func, arity);

		return(call);
	}

	@prepareNamespace('_nbind')
	export class _ {} // tslint:disable-line:class-name
}
