package android.os
class Bundle { val values=mutableMapOf<String,Any>(); fun putString(k:String,v:String){values[k]=v};fun putFloat(k:String,v:Float){values[k]=v};fun putInt(k:String,v:Int){values[k]=v} }
