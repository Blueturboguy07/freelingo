package expo.modules.widgetpublication

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import java.io.File

/** A single process-wide DataStore instance, outside every Android backup domain.
 * The provider and module share this singleton; no SQLite or application model is linked. */
object WidgetDataStore {
  private val publication=stringPreferencesKey("publication_v1")
  @Volatile private var instance:DataStore<Preferences>?=null
  @Synchronized private fun store(context:Context):DataStore<Preferences> {
    instance?.let{return it}
    val file=File(context.applicationContext.noBackupFilesDir,"freelingo-widget/publication.preferences_pb")
    file.parentFile!!.mkdirs()
    return PreferenceDataStoreFactory.create(scope=CoroutineScope(Dispatchers.IO+SupervisorJob())){file}.also{instance=it}
  }
  fun port(context:Context):WidgetRecordPort=object:WidgetRecordPort {
    override fun read():String?=runBlocking { store(context).data.first()[publication] }
    override fun write(json:String){runBlocking {store(context).edit{it[publication]=json}}}
  }
  suspend fun snapshot(context:Context):String? {
    val raw=store(context).data.first()[publication]?:return null
    val value=WidgetPublicationStorage.decode(raw).get("snapshotJson")
    return value as? String
  }
}
