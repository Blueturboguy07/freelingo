package expo.modules.widgetpublication

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.background
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.provideContent
import androidx.glance.layout.*
import androidx.glance.text.*
import androidx.glance.unit.ColorProvider
import java.time.ZoneId

/** Glance composables only. The host receives a snapshot view and explicit course URI. */
class FreelingoWidget:GlanceAppWidget() {
  override val sizeMode=SizeMode.Exact
  override suspend fun provideGlance(context:Context,id:GlanceId){
    val raw=try{WidgetDataStore.snapshot(context)}catch(_:Exception){null}
    provideContent {
      val model=WidgetSnapshotModel.render(raw,System.currentTimeMillis(),ZoneId.systemDefault().id)
      SnapshotContent(context,model)
    }
  }
}
class FreelingoWidgetReceiver:GlanceAppWidgetReceiver(){override val glanceAppWidget=FreelingoWidget()}
private object WidgetLayoutPolicy {
  // Initial native policy, 2026-09-13; max-font device evidence remains a release gate.
  val numeralSp=36.sp
  val padding=16.dp
}
@Composable private fun SnapshotContent(context:Context,model:WidgetViewState){
  val colour=when(model.flame){"lit"->Color(0xFFFF9600);"frozen"->Color(0xFF1CB0F6);else->Color(0xFF777777)}
  val launch=context.packageManager.getLaunchIntentForPackage(context.packageName)
    ?:Intent(Intent.ACTION_VIEW).setPackage(context.packageName)
  launch.action=Intent.ACTION_VIEW;launch.data=Uri.parse(model.deepLink)
  launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
  // Glance content is cached remotely. No baked numeric countdown is presented as live.
  val caption=if(model.state in listOf("NUDGE","DANGER"))"Practice today to extend your streak." else model.copy
  Column(modifier=GlanceModifier.fillMaxSize().background(Color.White).padding(WidgetLayoutPolicy.padding).clickable(actionStartActivity(launch)),verticalAlignment=Alignment.CenterVertically,horizontalAlignment=Alignment.CenterHorizontally){
    Row(verticalAlignment=Alignment.CenterVertically){
      Text(if(model.flame=="frozen")"❄" else if(model.flame=="none")"Freelingo" else "●",style=TextStyle(color=ColorProvider(colour),fontSize=24.sp,fontWeight=FontWeight.Bold),maxLines=1)
      if(model.streak!=null){Spacer(GlanceModifier.width(8.dp));Text(model.streak.toString(),style=TextStyle(color=ColorProvider(colour),fontSize=WidgetLayoutPolicy.numeralSp,fontWeight=FontWeight.Bold),maxLines=1)}
    }
    Spacer(GlanceModifier.height(8.dp))
    Text(caption,style=TextStyle(color=ColorProvider(Color(0xFF3C3C3C)),fontSize=16.sp,textAlign=TextAlign.Center),maxLines=3)
  }
}
